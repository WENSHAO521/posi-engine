#!/usr/bin/env node
/**
 * mint-elsevier-jnlactive-2026.mjs
 *
 * Final identity-minting step for bulk benchmark expansions (Elsevier
 * jnlactive.csv, Frontiers title list, and any future one). Takes
 * remap-benchmark-identity-2026.mjs's output (resolved.json +
 * unresolved-manual-review.json) and:
 *   1. Writes posi_id back onto every already-resolved record (reuse).
 *   2. Re-resolves every "unresolved" entity against a FRESHLY-LOADED
 *      registry/journal-id-map.csv via src/migration/mint.mjs's
 *      resolveOrMintIds() -- not a custom ad hoc loop -- before minting
 *      anything. This matters because unresolved-manual-review.json is a
 *      snapshot from whenever remap last ran; if the registry has since
 *      gained a row for that identity (a prior mint run, a manual fix, or
 *      simply re-running this script twice against the same input by
 *      mistake), resolveOrMintIds() reuses that row instead of minting a
 *      second POSI-J for the same journal. Only a genuinely still-absent
 *      identity gets a new id.
 *   3. Appends new rows to registry/journal-id-map.csv (never mutating
 *      existing rows -- see PJR-SPEC.md § 12).
 *   4. Writes posi_id back onto those newly-minted records too.
 *
 * Usage:
 *   node scripts/mint-elsevier-jnlactive-2026.mjs \
 *     --registry <path to registry/journal-id-map.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --resolved <path to resolved.json> \
 *     --unresolved <path to unresolved-manual-review.json> \
 *     --out <output dir> \
 *     [--superseded <path to registry/superseded-ids.csv>]
 *
 * --superseded matters here too: without it, an "unresolved" entity whose
 * identity value happens to match a RETIRED registry row would get
 * "reused" onto the old, superseded posi_id instead of either the
 * surviving id or a fresh mint.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { buildRegistryIndex, nextSequenceNumber } from '../src/migration/mint.mjs'
import { resolveOrMintIds } from '../src/migration/mint.mjs'
import { validateSupersessionRows, buildSupersessionMap, resolveSupersededId } from '../src/migration/supersession.mjs'
import { parseCsv } from '../src/showjcr/csv.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function parseRegistryCsv(text) {
  const lines = text.trim().split('\n')
  const header = lines[0].split(',')
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const row = {}
    header.forEach((h, j) => (row[h] = parts[j]))
    rows.push(row)
  }
  return rows
}

/** The `reason` column contains free text with commas -- must use the
 * real RFC4180 parser, not a naive split. */
function parseSupersededCsv(text) {
  const { rows } = parseCsv(text)
  return rows.map(r => ({ old_posi_id: r.old_posi_id, superseded_by_posi_id: r.superseded_by_posi_id }))
}

function main() {
  const registryPath = resolve(arg('registry'))
  const benchmarkPath = resolve(arg('benchmark'))
  const resolvedPath = resolve(arg('resolved'))
  const unresolvedPath = resolve(arg('unresolved'))
  const outDir = resolve(arg('out', 'mint-output'))
  const supersededPath = arg('superseded')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const registryRows = parseRegistryCsv(readFileSync(registryPath, 'utf-8'))
  const resolved = JSON.parse(readFileSync(resolvedPath, 'utf-8'))
  const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'))
  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))

  console.log(`Registry: ${registryRows.length} rows. Already-resolved (by remap): ${resolved.length}. To re-resolve/mint: ${unresolved.length}.`)

  let supersessionMap = new Map()
  if (supersededPath && existsSync(resolve(supersededPath))) {
    const supersessionRows = parseSupersededCsv(readFileSync(resolve(supersededPath), 'utf-8'))
    const knownPosiIds = new Set(registryRows.map(r => r.posi_id))
    const { valid, errors } = validateSupersessionRows(supersessionRows, { knownPosiIds })
    if (!valid) {
      console.error('registry/superseded-ids.csv failed validation:')
      errors.forEach(e => console.error(`  - ${e}`))
      process.exit(1)
    }
    supersessionMap = buildSupersessionMap(supersessionRows)
    console.log(`Loaded ${supersessionRows.length} supersession row(s) -- validated.`)
  }

  const legacyIdToPosiId = new Map()
  for (const r of resolved) {
    const posiId = supersessionMap.size > 0 ? resolveSupersededId(r.posi_id, supersessionMap) : r.posi_id
    for (const legacyId of r.member_legacy_ids) legacyIdToPosiId.set(legacyId, posiId)
  }

  // Re-resolve every "unresolved" entity against a freshly-built registry
  // index -- reuses instead of double-minting if the registry has moved on
  // since unresolved-manual-review.json was generated. Superseded ids are
  // forwarded to their surviving id so an unresolved entity that happens
  // to match a retired identity value reuses the CURRENT record, not the
  // retired one.
  const rawRegistryIndex = buildRegistryIndex(registryRows)
  const registryIndex = supersessionMap.size > 0
    ? new Map([...rawRegistryIndex].map(([key, posiId]) => [key, resolveSupersededId(posiId, supersessionMap)]))
    : rawRegistryIndex
  const startSequence = nextSequenceNumber(registryRows)
  const today = new Date().toISOString().slice(0, 10)

  const entities = unresolved.map(e => ({
    candidate_id: e.candidate_id,
    issn_l: null, // raw jnlactive.csv/Frontiers/OpenAlex data has no distinct issn_l field
    issn_set: e.issn_set,
    openalex_source_ids: e.openalex_source_ids,
    representative_title: e.representative_title,
  }))

  const { assignments, newRegistryRows, unresolved: stillUnresolved } = resolveOrMintIds(entities, registryIndex, startSequence, today)

  const reusedOnReResolve = assignments.filter(a => !a.minted)
  const mintedAssignments = assignments.filter(a => a.minted)
  if (reusedOnReResolve.length > 0) {
    console.log(`${reusedOnReResolve.length} entit(ies) marked "unresolved" by remap actually already had a registry entry as of right now -- reused instead of double-minting:`)
    for (const a of reusedOnReResolve) console.log(`  - ${a.candidate_id}: reused ${a.posi_id}`)
  }
  console.log(`Minted ${mintedAssignments.length} new POSI-J ids (${stillUnresolved.length} skipped, no identity signal at all).`)

  const entityByCandidateId = new Map(unresolved.map(e => [e.candidate_id, e]))
  for (const a of assignments) {
    const entity = entityByCandidateId.get(a.candidate_id)
    for (const legacyId of entity.member_legacy_ids) legacyIdToPosiId.set(legacyId, a.posi_id)
  }

  // Append-only write to the registry -- never touch existing rows.
  const newRegistryLines = newRegistryRows.map(r => `${r.posi_id},${r.identity_type},${r.identity_value},${r.first_seen}`)
  appendFileSync(registryPath, newRegistryLines.map(l => l + '\n').join(''), 'utf-8')

  // Write posi_id back onto every benchmark record (both reused and newly minted).
  let written = 0
  const updatedBenchmark = benchmark.map(r => {
    const posiId = legacyIdToPosiId.get(r.id)
    if (!posiId) return r
    written++
    return { ...r, posi_id: posiId }
  })
  writeFileSync(benchmarkPath, JSON.stringify(updatedBenchmark, null, 2) + '\n', 'utf-8')

  const summary = {
    registry_rows_before: registryRows.length,
    registry_rows_minted: newRegistryRows.length,
    registry_rows_after: registryRows.length + newRegistryRows.length,
    reused_on_re_resolve_not_double_minted: reusedOnReResolve.length,
    benchmark_records_total: updatedBenchmark.length,
    benchmark_records_with_posi_id_written_this_run: written,
    benchmark_records_still_without_posi_id: updatedBenchmark.filter(r => !r.posi_id).length,
    still_unresolved_no_identity_signal: stillUnresolved.length,
  }
  writeFileSync(join(outDir, 'mint-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main()
