#!/usr/bin/env node
/**
 * mint-elsevier-jnlactive-2026.mjs
 *
 * Final identity-minting step for the jnlactive.csv Elsevier expansion.
 * Takes remap-benchmark-identity-2026.mjs's output (resolved.json +
 * unresolved-manual-review.json, both already deduped and confirmed
 * conflict-free) and:
 *   1. Writes posi_id back onto every already-resolved record (reuse).
 *   2. Mints a new sequential POSI-J id for every genuinely-new entity in
 *      unresolved-manual-review.json, appending new rows to
 *      registry/journal-id-map.csv (never mutating existing rows -- see
 *      PJR-SPEC.md § 12).
 *   3. Writes posi_id back onto those newly-minted records too.
 *
 * Deliberately a separate script from remap-benchmark-identity-2026.mjs,
 * which intentionally never mints -- this script exists specifically for
 * the (rarer, higher-stakes) case where genuine new-to-the-registry
 * entities have been reviewed and minting is explicitly authorized.
 *
 * Usage:
 *   node scripts/mint-elsevier-jnlactive-2026.mjs \
 *     --registry <path to registry/journal-id-map.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --resolved <path to resolved.json> \
 *     --unresolved <path to unresolved-manual-review.json> \
 *     --out <output dir>
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { formatPosiId, nextSequenceNumber } from '../src/migration/mint.mjs'
import { primaryIdentity } from '../src/migration/identity.mjs'

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

function main() {
  const registryPath = resolve(arg('registry'))
  const benchmarkPath = resolve(arg('benchmark'))
  const resolvedPath = resolve(arg('resolved'))
  const unresolvedPath = resolve(arg('unresolved'))
  const outDir = resolve(arg('out', 'mint-output'))
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const registryRows = parseRegistryCsv(readFileSync(registryPath, 'utf-8'))
  const resolved = JSON.parse(readFileSync(resolvedPath, 'utf-8'))
  const unresolved = JSON.parse(readFileSync(unresolvedPath, 'utf-8'))
  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))

  console.log(`Registry: ${registryRows.length} rows. Already-resolved: ${resolved.length}. To mint: ${unresolved.length}.`)

  const legacyIdToPosiId = new Map()
  for (const r of resolved) {
    for (const legacyId of r.member_legacy_ids) legacyIdToPosiId.set(legacyId, r.posi_id)
  }

  let seq = nextSequenceNumber(registryRows)
  const today = new Date().toISOString().slice(0, 10)
  const newRegistryLines = []
  const mintedAssignments = []

  for (const entity of unresolved) {
    const identity = primaryIdentity({
      hasIssnL: false, // raw jnlactive.csv/OpenAlex data has no distinct issn_l field
      issnSet: entity.issn_set,
      openalexId: entity.openalex_source_ids?.[0] ?? null,
      doajId: null,
    })
    if (identity.tier === 'unresolved') {
      // No ISSN, no OpenAlex id at all -- should not happen given this
      // script only receives entities that already had SOME identity
      // signal (that's why remap-benchmark-identity-2026.mjs put them in
      // unresolved-manual-review.json rather than dropping them), but
      // guard anyway rather than mint against nothing.
      console.warn(`SKIPPED (no identity signal at all): ${entity.representative_title} [${entity.member_legacy_ids.join(', ')}]`)
      continue
    }
    const posiId = formatPosiId(seq)
    seq += 1
    newRegistryLines.push(`${posiId},${identity.tier},${identity.key},${today}`)
    for (const legacyId of entity.member_legacy_ids) legacyIdToPosiId.set(legacyId, posiId)
    mintedAssignments.push({ candidate_id: entity.candidate_id, posi_id: posiId, title: entity.representative_title, identity_type: identity.tier, identity_value: identity.key })
  }

  console.log(`Minted ${mintedAssignments.length} new POSI-J ids (${unresolved.length - mintedAssignments.length} skipped, no identity signal).`)

  // Append-only write to the registry -- never touch existing rows.
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
    registry_rows_minted: mintedAssignments.length,
    registry_rows_after: registryRows.length + mintedAssignments.length,
    benchmark_records_total: updatedBenchmark.length,
    benchmark_records_with_posi_id_written_this_run: written,
    benchmark_records_still_without_posi_id: updatedBenchmark.filter(r => !r.posi_id).length,
  }
  writeFileSync(join(outDir, 'mint-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main()
