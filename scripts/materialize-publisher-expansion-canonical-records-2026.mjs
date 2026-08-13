#!/usr/bin/env node
/**
 * materialize-publisher-expansion-canonical-records-2026.mjs
 *
 * mint-elsevier-jnlactive-2026.mjs (and its Frontiers counterpart) already
 * minted every POSI-J id the 2026-08 publisher-catalog expansion needed --
 * that work is done, registry/journal-id-map.csv already has the rows.
 * What never happened is PJR-SPEC.md § 12's other half: "bulk migration
 * writes registry rows AND journal records together." 2,177 of those
 * minted ids (verified by diffing every registry id against every actual
 * journals/core/ + journals/discovered/ record, not assumed) have no
 * canonical journal record at all -- an id that resolves to nothing if
 * looked up, which is a real gap, not a cosmetic one.
 *
 * This script closes it: for every registry id with (a) no canonical
 * record and (b) a matching corpus/global-benchmark.json record carrying
 * that posi_id, writes a schema-valid `status: "discovered"` record to a
 * NEW file (journals/discovered/publisher-expansion-2026.jsonl) --
 * initial-journal-migration-2026.jsonl is never touched, so that file
 * stays an accurate record of what the original 23,331-id migration
 * actually produced.
 *
 * identifiers.issn_l is always null for these records -- matching
 * mint-elsevier-jnlactive-2026.mjs's own documented reasoning ("raw
 * jnlactive.csv/Frontiers/OpenAlex data has no distinct issn_l field").
 * The corpus record's issn_online (whatever value it currently holds --
 * this script does not re-derive or "fix" it; that is a separate corpus-
 * level decision, not this one) is carried through unchanged, matching
 * exactly what registry/journal-id-map.csv already used to mint the id
 * (identity_type: issn_pair) -- this script is a faithful materialization
 * of already-decided identity, not a second opinion on it.
 *
 * `language` is written null unconditionally, never copied from the
 * corpus record's own `language` field -- that field was a hardcoded
 * "English" default on every pre-2026-08-13 ingest run (see posi-engine's
 * bulk-ingest-fabricated-defaults-2026 fix), and journal.schema.json's
 * `language` is a BCP-47 array shape the corpus's flat string never
 * matched anyway, so there is no faithful mapping to carry through even
 * if the corpus value were trustworthy.
 *
 * Any id that is neither in the corpus nor documented in registry/
 * excluded-identities.csv is reported, not silently skipped -- an
 * unexplained gap is exactly what this script exists to catch.
 *
 * Usage:
 *   node scripts/materialize-publisher-expansion-canonical-records-2026.mjs \
 *     --registry <path to registry/journal-id-map.csv> \
 *     --core-dir <path to journals/core> \
 *     --discovered-dir <path to journals/discovered> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --excluded <path to registry/excluded-identities.csv> \
 *     --superseded <path to registry/superseded-ids.csv> \
 *     --out <path to write journals/discovered/publisher-expansion-2026.jsonl>
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { parseCsv } from '../src/showjcr/csv.mjs'
import { validateIsoCountryCode } from '../src/migration/bulk-ingest-helpers.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function parseRegistryCsv(text) {
  const { rows } = parseCsv(text)
  return rows
}

function walkJsonFiles(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJsonFiles(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

function loadCanonicalIds(coreDir, discoveredDir, excludeFilename) {
  const ids = new Set()
  for (const f of walkJsonFiles(coreDir)) {
    const rec = JSON.parse(readFileSync(f, 'utf-8'))
    ids.add(rec.id)
  }
  let discoveredFiles
  try { discoveredFiles = readdirSync(discoveredDir).filter(f => f.endsWith('.jsonl') && f !== excludeFilename) } catch { discoveredFiles = [] }
  for (const f of discoveredFiles) {
    const lines = readFileSync(join(discoveredDir, f), 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) ids.add(JSON.parse(line).id)
  }
  return ids
}

function buildCanonicalRecord(benchmarkRecord) {
  const now = new Date().toISOString()
  return {
    id: benchmarkRecord.posi_id,
    title: benchmarkRecord.title,
    short_title: benchmarkRecord.short_title ?? null,
    status: 'discovered',
    publisher: benchmarkRecord.publisher ?? null,
    // The corpus's own `country` field was written without validating
    // OpenAlex's country_code is a real ISO 3166-1 alpha-2 value (fixed
    // going forward in bulk-ingest-fabricated-defaults-2026, not
    // retroactively on the corpus) -- re-validated here since a handful of
    // existing corpus records carry a MARC country code (e.g. "XXK", "ENK")
    // instead, caught by running this exact check against the real data.
    country: validateIsoCountryCode(benchmarkRecord.country),
    language: null,
    open_access: benchmarkRecord.open_access ?? null,
    license: null,
    website_url: benchmarkRecord.website_url ?? null,
    identifiers: {
      issn_l: null,
      issn_print: benchmarkRecord.issn_print ?? null,
      issn_online: benchmarkRecord.issn_online ?? null,
      openalex_source_id: benchmarkRecord.openalex_source_id ?? null,
      crossref_member_id: null,
      ror_publisher_id: null,
      doaj_id: null,
    },
    classification: null,
    coverage: null,
    selection: null,
    provenance: [
      { source: 'posi_curation', source_record_id: benchmarkRecord.id, retrieved_at: now, license: null },
      ...(benchmarkRecord.openalex_source_id
        ? [{ source: 'openalex', source_record_id: benchmarkRecord.openalex_source_id, retrieved_at: now, license: 'CC0-1.0' }]
        : []),
    ],
    created_at: now,
    updated_at: now,
  }
}

function main() {
  const registryPath = resolve(arg('registry'))
  const coreDir = resolve(arg('core-dir'))
  const discoveredDir = resolve(arg('discovered-dir'))
  const benchmarkPath = resolve(arg('benchmark'))
  const excludedPath = arg('excluded')
  const supersededPath = arg('superseded')
  const outPath = resolve(arg('out'))

  const registryRows = parseRegistryCsv(readFileSync(registryPath, 'utf-8'))
  const registryIds = new Set(registryRows.map(r => r.posi_id))
  console.log(`Registry: ${registryRows.length} rows, ${registryIds.size} unique posi_id.`)

  const supersededOldIds = new Set()
  if (supersededPath) {
    const { rows } = parseCsv(readFileSync(resolve(supersededPath), 'utf-8'))
    for (const r of rows) supersededOldIds.add(r.old_posi_id)
    console.log(`Superseded (retired) ids, expected to have no canonical record: ${supersededOldIds.size}`)
  }

  const excludedNote = new Map()
  if (excludedPath) {
    const { rows } = parseCsv(readFileSync(resolve(excludedPath), 'utf-8'))
    for (const r of rows) {
      const m = r.reason?.match(/POSI-J-\d{6,}/)
      if (m) excludedNote.set(m[0], r.reason)
    }
    console.log(`Excluded-identity rows mentioning a specific left-unused posi_id: ${excludedNote.size}`)
  }

  // Exclude this script's own output file from the "already exists" scan --
  // otherwise a second run against a directory that already has this run's
  // prior output sees every id as already covered and (re-)writes nothing,
  // silently discarding whatever the previous run actually produced.
  const outFilename = outPath.split(/[\\/]/).pop()
  const canonicalIds = loadCanonicalIds(coreDir, discoveredDir, outFilename)
  console.log(`Existing canonical records (journals/core/ + journals/discovered/*.jsonl): ${canonicalIds.size}`)

  const missing = [...registryIds].filter(id => !canonicalIds.has(id) && !supersededOldIds.has(id) && !excludedNote.has(id))
  console.log(`Registry ids with no canonical record, not superseded, not a documented exclusion: ${missing.length}`)

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  const benchmarkByPosiId = new Map(benchmark.filter(j => j.posi_id).map(j => [j.posi_id, j]))

  const toWrite = []
  const unexplained = []
  for (const id of missing) {
    const rec = benchmarkByPosiId.get(id)
    if (!rec) { unexplained.push(id); continue }
    toWrite.push(buildCanonicalRecord(rec))
  }

  if (unexplained.length > 0) {
    console.log(`\nUNEXPLAINED -- registry id has no canonical record, is not superseded/excluded, and has no matching corpus/global-benchmark.json posi_id either (${unexplained.length}):`)
    unexplained.forEach(id => console.log(`  - ${id}`))
  }

  // Duplicate guard: a posi_id already present in an existing canonical
  // file must never also appear in this new output -- would violate "never
  // reused, never duplicated."
  const dupes = toWrite.filter(r => canonicalIds.has(r.id))
  if (dupes.length > 0) {
    console.error(`FATAL: ${dupes.length} record(s) about to be written already have a canonical record. Aborting, nothing written.`)
    dupes.forEach(r => console.error(`  - ${r.id}`))
    process.exit(1)
  }
  const idsInThisBatch = new Set()
  const internalDupes = toWrite.filter(r => idsInThisBatch.has(r.id) || !idsInThisBatch.add(r.id))
  if (internalDupes.length > 0) {
    console.error(`FATAL: duplicate posi_id within this batch itself. Aborting, nothing written.`)
    internalDupes.forEach(r => console.error(`  - ${r.id}`))
    process.exit(1)
  }

  writeFileSync(outPath, toWrite.map(r => JSON.stringify(r)).join('\n') + (toWrite.length ? '\n' : ''), 'utf-8')

  const finalCanonicalIds = new Set([...canonicalIds, ...toWrite.map(r => r.id)])
  const finalGap = [...registryIds].filter(id => !finalCanonicalIds.has(id) && !supersededOldIds.has(id) && !excludedNote.has(id))

  const summary = {
    registry_unique_ids: registryIds.size,
    canonical_before: canonicalIds.size,
    materialized_this_run: toWrite.length,
    canonical_after: finalCanonicalIds.size,
    superseded_old_ids_excluded: supersededOldIds.size,
    documented_excluded_ids: excludedNote.size,
    unexplained_gap_no_corpus_match: unexplained.length,
    final_gate_registry_id_without_canonical_record: finalGap.length,
  }
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  if (finalGap.length > 0) {
    console.log('Remaining unresolved gap ids:', finalGap.slice(0, 20))
  }
}

main()
