/**
 * POSI-J id minting — posi-data/registry/README.md's "resolve identity
 * against the registry before minting" rule, and PJR-SPEC.md § 12's "an id
 * is never derived from a source file's row order or array index."
 *
 * Pure functions: given the existing registry rows (already loaded from
 * registry/journal-id-map.csv) and a batch of candidate entities (dedupe.mjs
 * output), decide which candidates already have an id (reuse it) and which
 * need a new one (mint the next sequential id) — without ever reusing or
 * reassigning an id. No file I/O here; the calling script reads/writes
 * registry/journal-id-map.csv itself.
 */

import { primaryIdentity } from './identity.mjs'

const POSI_ID_PREFIX = 'POSI-J-'
const POSI_ID_DIGITS = 6

export function formatPosiId(n) {
  return `${POSI_ID_PREFIX}${String(n).padStart(POSI_ID_DIGITS, '0')}`
}

/**
 * @param {{ posi_id: string }[]} existingRows - registry/journal-id-map.csv rows
 * @returns {number} the next unused sequence number (existing max + 1, or 1 if the registry is empty)
 */
export function nextSequenceNumber(existingRows) {
  let max = 0
  for (const row of existingRows) {
    const match = /^POSI-J-(\d+)$/.exec(row.posi_id)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  }
  return max + 1
}

/** @returns {Map<string,string>} "identity_type:identity_value" -> posi_id */
export function buildRegistryIndex(existingRows) {
  const idx = new Map()
  for (const row of existingRows) {
    idx.set(`${row.identity_type}:${row.identity_value}`, row.posi_id)
  }
  return idx
}

/**
 * Resolves each candidate entity against the registry (reusing an existing
 * id if its identity is already known) or mints a new sequential id for a
 * genuinely new entity. Entities with tier `unresolved` (no ISSN, no
 * OpenAlex id — primaryIdentity() falls through every tier) are never
 * assigned an id automatically; they're returned separately for manual
 * review, per registry/README.md tier 5.
 *
 * @param {{ candidate_id: string, issn_l?: string|null, issn_set: string[], openalex_source_ids: string[], representative_title: string|null }[]} entities
 *   `issn_l`, when the caller has it (this project resolves it from a live
 *   OpenAlex source lookup, not from dedupe.mjs's generic issn_set, which
 *   deliberately doesn't distinguish issn_l from plain print/online ISSNs —
 *   see identity.mjs), gives this entity true registry tier-1 priority.
 *   Without it, an entity still resolves via tier 2 (ISSN pair) or tier 3
 *   (OpenAlex Source ID) — it is never left unresolved just because issn_l
 *   is unknown, only when NO identity signal at all is present.
 * @param {Map<string,string>} registryIndex - buildRegistryIndex() output
 * @param {number} startSequence - nextSequenceNumber() output; mutated locally, not by reference
 * @param {string} today - ISO date string for first_seen on newly minted rows
 * @returns {{
 *   assignments: { candidate_id: string, posi_id: string, identity_type: string, identity_value: string, minted: boolean }[],
 *   newRegistryRows: { posi_id: string, identity_type: string, identity_value: string, first_seen: string }[],
 *   unresolved: object[],
 * }}
 */
export function resolveOrMintIds(entities, registryIndex, startSequence, today) {
  const assignments = []
  const newRegistryRows = []
  const unresolved = []
  let seq = startSequence

  for (const entity of entities) {
    const hasIssnL = !!entity.issn_l
    const issnSet = hasIssnL ? [entity.issn_l, ...entity.issn_set.filter(i => i !== entity.issn_l)] : entity.issn_set
    const identity = primaryIdentity({
      hasIssnL,
      issnSet,
      openalexId: entity.openalex_source_ids?.[0] ?? null,
      doajId: null,
    })

    if (identity.tier === 'unresolved') {
      unresolved.push(entity)
      continue
    }

    const key = `${identity.tier}:${identity.key}`
    const existingId = registryIndex.get(key)
    if (existingId) {
      assignments.push({ candidate_id: entity.candidate_id, posi_id: existingId, identity_type: identity.tier, identity_value: identity.key, minted: false })
      continue
    }

    const posiId = formatPosiId(seq)
    seq += 1
    assignments.push({ candidate_id: entity.candidate_id, posi_id: posiId, identity_type: identity.tier, identity_value: identity.key, minted: true })
    const newRow = { posi_id: posiId, identity_type: identity.tier, identity_value: identity.key, first_seen: today }
    newRegistryRows.push(newRow)
    registryIndex.set(key, posiId) // so a later candidate in the same batch sharing this identity reuses it, not double-mints
  }

  return { assignments, newRegistryRows, unresolved }
}
