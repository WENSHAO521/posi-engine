/**
 * Deduplication — implements the "conflict beats match" rule: a strong
 * signal (ISSN) always wins over a weaker one (OpenAlex Source ID), which
 * always wins over the weakest (title/publisher, which never auto-merges
 * at all). See posi-data/registry/README.md.
 */

import { extractIdentitySignals } from './identity.mjs'

class DisjointSet {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]] // path halving
      x = this.parent[x]
    }
    return x
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra
    else { this.parent[rb] = ra; this.rank[ra]++ }
  }
}

/**
 * @param {object[]} normalizedRecords - normalize.mjs output, one per source record
 * @returns {{
 *   entities: object[],           // one per candidate journal entity (union-find group or singleton)
 *   hardConflicts: object[],      // OpenAlex ids that would have merged non-overlapping ISSN groups
 *   possibleDuplicates: object[], // title+publisher matches across otherwise-unrelated entities
 * }}
 */
export function buildCandidateEntities(normalizedRecords) {
  const n = normalizedRecords.length
  const signals = normalizedRecords.map(extractIdentitySignals)
  const dsu = new DisjointSet(n)

  // --- Pass 1: union via ISSN overlap (strongest signal) ---
  const issnToIndices = new Map()
  signals.forEach((sig, i) => {
    for (const issn of sig.issnSet) {
      if (!issnToIndices.has(issn)) issnToIndices.set(issn, [])
      issnToIndices.get(issn).push(i)
    }
  })
  for (const indices of issnToIndices.values()) {
    for (let k = 1; k < indices.length; k++) dsu.union(indices[0], indices[k])
  }

  // Group ISSN sets per current root, for the conflict check in pass 2.
  function groupIssnSet(root, rootIssnSets) {
    if (!rootIssnSets.has(root)) rootIssnSets.set(root, new Set())
    return rootIssnSets.get(root)
  }
  const rootIssnSets = new Map()
  signals.forEach((sig, i) => {
    const root = dsu.find(i)
    const set = groupIssnSet(root, rootIssnSets)
    for (const issn of sig.issnSet) set.add(issn)
  })

  // --- Pass 2: union via OpenAlex Source ID, UNLESS it would merge two
  // groups that both carry non-empty, non-overlapping ISSN evidence ---
  const openalexToIndices = new Map()
  signals.forEach((sig, i) => {
    if (!sig.openalexId) return
    if (!openalexToIndices.has(sig.openalexId)) openalexToIndices.set(sig.openalexId, [])
    openalexToIndices.get(sig.openalexId).push(i)
  })

  const hardConflicts = []
  for (const [openalexId, indices] of openalexToIndices) {
    const rootsInvolved = [...new Set(indices.map(i => dsu.find(i)))]
    if (rootsInvolved.length <= 1) continue // already one group, or singleton — nothing to do

    // Do two distinct roots both carry non-empty, non-overlapping ISSN sets?
    let conflict = null
    outer: for (let a = 0; a < rootsInvolved.length; a++) {
      for (let b = a + 1; b < rootsInvolved.length; b++) {
        const setA = rootIssnSets.get(rootsInvolved[a]) ?? new Set()
        const setB = rootIssnSets.get(rootsInvolved[b]) ?? new Set()
        if (setA.size === 0 || setB.size === 0) continue // no evidence to conflict with
        const overlaps = [...setA].some(x => setB.has(x))
        if (!overlaps) { conflict = { rootA: rootsInvolved[a], rootB: rootsInvolved[b], setA: [...setA], setB: [...setB] }; break outer }
      }
    }

    if (conflict) {
      hardConflicts.push({
        type: 'openalex_id_spans_conflicting_issn_groups',
        openalex_source_id: openalexId,
        legacy_ids: indices.map(i => normalizedRecords[i].legacy_id),
        conflicting_issn_sets: rootsInvolved.map(r => [...(rootIssnSets.get(r) ?? [])]),
      })
      // Do not union any of this bucket — leave the ISSN-based grouping as
      // the source of truth and let a human resolve the OpenAlex mismatch.
      continue
    }

    // No conflict: safe to union all roots sharing this OpenAlex id.
    for (let k = 1; k < indices.length; k++) dsu.union(indices[0], indices[k])
    // Merge their ISSN-set bookkeeping so later buckets see the combined set.
    const newRoot = dsu.find(indices[0])
    const merged = groupIssnSet(newRoot, rootIssnSets)
    for (const r of rootsInvolved) for (const issn of (rootIssnSets.get(r) ?? [])) merged.add(issn)
  }

  // --- Assemble candidate entities from final union-find groups ---
  const groups = new Map() // root -> record indices
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }

  let candSeq = 0
  const entities = [...groups.values()].map(indices => {
    candSeq++
    const members = indices.map(i => normalizedRecords[i])
    const allSignals = indices.map(i => signals[i])
    const issnSet = [...new Set(allSignals.flatMap(s => s.issnSet))]
    const openalexIds = [...new Set(allSignals.map(s => s.openalexId).filter(Boolean))]
    const resolved = issnSet.length > 0 || openalexIds.length > 0
    return {
      candidate_id: `CAND-${String(candSeq).padStart(6, '0')}`,
      status: resolved ? 'resolved' : 'unresolved',
      member_legacy_ids: members.map(m => m.legacy_id),
      member_count: members.length,
      issn_set: issnSet,
      openalex_source_ids: openalexIds,
      titles: [...new Set(members.map(m => m.title).filter(Boolean))],
      representative_title: members.find(m => m.title)?.title ?? null,
    }
  })

  // --- Possible duplicates: normalized title+publisher match across
  // DIFFERENT candidate entities. Purely informational — never merged. ---
  const entityByLegacyId = new Map()
  entities.forEach(e => e.member_legacy_ids.forEach(id => entityByLegacyId.set(id, e.candidate_id)))

  const titlePubToLegacyIds = new Map()
  normalizedRecords.forEach(r => {
    if (!r.title || !r.publisher) return
    const key = `${r.title.toLowerCase()}::${r.publisher.toLowerCase()}`
    if (!titlePubToLegacyIds.has(key)) titlePubToLegacyIds.set(key, [])
    titlePubToLegacyIds.get(key).push(r.legacy_id)
  })

  const possibleDuplicates = []
  for (const [key, legacyIds] of titlePubToLegacyIds) {
    const distinctEntities = new Set(legacyIds.map(id => entityByLegacyId.get(id)))
    if (distinctEntities.size > 1) {
      const [title, publisher] = key.split('::')
      possibleDuplicates.push({
        title,
        publisher,
        legacy_ids: legacyIds,
        candidate_entities: [...distinctEntities],
      })
    }
  }

  return { entities, hardConflicts, possibleDuplicates }
}
