#!/usr/bin/env node
/**
 * benchmark-identity-remap-2026 — one-off script (not part of the ongoing
 * src/ API surface). Resolves the 1000 Global Benchmark journals
 * (posi-data corpus/global-benchmark.json) against the CURRENT
 * registry/journal-id-map.csv (24,205 real, canonical records) and writes
 * back a `posi_id` field wherever a match is found. Reuse-before-mint:
 * this script does NOT mint new ids for anything it cannot resolve — those
 * go to a manual-review report instead of a guess.
 *
 * Deliberately does a VALUE-based join against the registry (does this
 * literal ISSN/OpenAlex-id string appear anywhere in the registry,
 * regardless of which identity_type it was recorded under), not a
 * strict-tier join via mint.mjs's resolveOrMintIds() — the registry may
 * have recorded a benchmark journal's ISSN under identity_type "issn_l"
 * (via OpenAlex enrichment during the recent real migration) while this
 * script, working from raw source data with no issn_l field, would only
 * ever compute a tier of "issn_pair" for the same literal value. A
 * tier-strict join would produce false "unresolved" results purely from a
 * type-label mismatch, not a genuine identity mismatch.
 *
 * Usage:
 *   node scripts/remap-benchmark-identity-2026.mjs \
 *     --registry <path to registry/journal-id-map.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --out <output dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { normalizeRecord } from '../src/migration/normalize.mjs'
import { buildCandidateEntities } from '../src/migration/dedupe.mjs'

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

/** value -> [{ posi_id, identity_type }] — an array because a genuinely
 * malformed registry could (in principle) have the same literal value
 * recorded under two different posi_ids; that's a conflict to surface,
 * not silently pick one. */
function buildValueIndex(registryRows) {
  const idx = new Map()
  for (const row of registryRows) {
    if (!idx.has(row.identity_value)) idx.set(row.identity_value, [])
    idx.get(row.identity_value).push({ posi_id: row.posi_id, identity_type: row.identity_type })
  }
  return idx
}

function main() {
  const registryPath = resolve(arg('registry'))
  const benchmarkPath = resolve(arg('benchmark'))
  const outDir = resolve(arg('out', 'benchmark-remap-output'))
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const registryRows = parseRegistryCsv(readFileSync(registryPath, 'utf-8'))
  console.log(`Loaded ${registryRows.length} registry rows.`)
  const valueIndex = buildValueIndex(registryRows)

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  console.log(`Loaded ${benchmark.length} benchmark records.`)

  // --- Normalize + internal dedupe (catches duplicate journals WITHIN
  // the benchmark file itself, before touching the registry at all) ---
  const normalizedRecords = benchmark.map(r =>
    normalizeRecord({
      source_collection: 'global-benchmark',
      legacy_id: r.id,
      title: r.title,
      short_title: r.short_title,
      issn_print: r.issn_print,
      issn_online: r.issn_online,
      issn_l: null,
      publisher: r.publisher,
      country: r.country,
      website_url: r.website_url,
      openalex_source_id: r.openalex_source_id,
      doaj_status: r.doaj_status,
      doaj_id: null,
      article_count: r.article_count,
    }).normalized
  )
  const dedupe = buildCandidateEntities(normalizedRecords)
  console.log(
    `Internal dedupe: ${dedupe.entities.length} candidate entities from ${benchmark.length} records ` +
    `(${dedupe.hardConflicts.length} hard conflicts, ${dedupe.possibleDuplicates.length} possible-duplicate groups).`
  )

  // --- Resolve each candidate entity against the registry, by VALUE ---
  const legacyIdToRecord = new Map(benchmark.map(r => [r.id, r]))
  const resolved = []
  const unresolved = []
  const registryConflicts = [] // an entity's own identity values map to >1 distinct posi_id
  const valueMismatches = []   // an entity's identity values map to registry hits under differing identity_type labels for the SAME posi_id (informational only)

  for (const entity of dedupe.entities) {
    const candidateValues = [...entity.issn_set, ...entity.openalex_source_ids]
    const hits = [] // { value, posi_id, identity_type }
    for (const v of candidateValues) {
      const registryHits = valueIndex.get(v)
      if (registryHits) for (const h of registryHits) hits.push({ value: v, ...h })
    }

    const distinctPosiIds = [...new Set(hits.map(h => h.posi_id))]

    if (distinctPosiIds.length === 0) {
      unresolved.push({ candidate_id: entity.candidate_id, representative_title: entity.representative_title, member_legacy_ids: entity.member_legacy_ids, issn_set: entity.issn_set, openalex_source_ids: entity.openalex_source_ids })
      continue
    }
    if (distinctPosiIds.length > 1) {
      registryConflicts.push({ candidate_id: entity.candidate_id, representative_title: entity.representative_title, member_legacy_ids: entity.member_legacy_ids, hits })
      continue
    }

    const posiId = distinctPosiIds[0]
    const distinctTypes = [...new Set(hits.map(h => h.identity_type))]
    if (distinctTypes.length > 1) {
      valueMismatches.push({ candidate_id: entity.candidate_id, posi_id: posiId, hits })
    }
    resolved.push({
      candidate_id: entity.candidate_id,
      posi_id: posiId,
      representative_title: entity.representative_title,
      member_legacy_ids: entity.member_legacy_ids,
      matched_via: hits.map(h => `${h.identity_type}:${h.value}`),
    })
  }

  // --- Write posi_id back onto the benchmark records for resolved entities ---
  let recordsUpdated = 0
  const updatedBenchmark = benchmark.map(r => {
    const entity = dedupe.entities.find(e => e.member_legacy_ids.includes(r.id))
    const match = resolved.find(x => x.candidate_id === entity?.candidate_id)
    if (match) {
      recordsUpdated++
      return { ...r, posi_id: match.posi_id }
    }
    return r
  })

  // --- Schema validation: posi_id shape + uniqueness across the output ---
  const posiIdPattern = /^POSI-J-[0-9]{6,}$/
  const shapeInvalid = updatedBenchmark.filter(r => r.posi_id && !posiIdPattern.test(r.posi_id))
  const posiIdCounts = new Map()
  for (const r of updatedBenchmark) {
    if (!r.posi_id) continue
    posiIdCounts.set(r.posi_id, (posiIdCounts.get(r.posi_id) ?? 0) + 1)
  }
  const duplicateAssignments = [...posiIdCounts.entries()].filter(([, count]) => count > 1)

  const summary = {
    input_benchmark_journals: benchmark.length,
    candidate_entities_after_internal_dedupe: dedupe.entities.length,
    internal_hard_conflicts: dedupe.hardConflicts.length,
    internal_possible_duplicates: dedupe.possibleDuplicates.length,
    matched_total: resolved.length,
    matched_by_issn_l: resolved.filter(r => r.matched_via.some(v => v.startsWith('issn_l:'))).length,
    matched_by_issn_pair: resolved.filter(r => r.matched_via.some(v => v.startsWith('issn_pair:')) && !r.matched_via.some(v => v.startsWith('issn_l:'))).length,
    matched_by_openalex: resolved.filter(r => r.matched_via.every(v => v.startsWith('openalex:'))).length,
    unresolved_manual_review: unresolved.length,
    registry_conflicts: registryConflicts.length,
    value_type_mismatches_informational: valueMismatches.length,
    new_ids_minted: 0,
    records_with_posi_id_written: recordsUpdated,
    schema_shape_invalid: shapeInvalid.length,
    duplicate_posi_id_assignments: duplicateAssignments.length,
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'resolved.json'), JSON.stringify(resolved, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'unresolved-manual-review.json'), JSON.stringify(unresolved, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'registry-conflicts.json'), JSON.stringify(registryConflicts, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'internal-hard-conflicts.json'), JSON.stringify(dedupe.hardConflicts, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'internal-possible-duplicates.json'), JSON.stringify(dedupe.possibleDuplicates, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'value-type-mismatches.json'), JSON.stringify(valueMismatches, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'global-benchmark.remapped.json'), JSON.stringify(updatedBenchmark, null, 2), 'utf-8')

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main()
