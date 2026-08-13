#!/usr/bin/env node
/**
 * ingest-frontiers-2026.mjs
 *
 * Adds the Frontiers journals listed in posi-data's
 * source-lists/frontiers-titlelist-web-2026.csv (Journal, ISSN, URL --
 * distributed via the Swiss Academic Libraries consortium, with an 11-line
 * preamble before the real header) that are NOT YET present in
 * corpus/global-benchmark.json (matched by ISSN) as new benchmark records,
 * enriched via OpenAlex's free singleton per-ISSN lookup. Mirrors
 * ingest-jnlactive-elsevier-2026.mjs's structure exactly.
 *
 * Does NOT mint POSI-J ids -- that is scripts/remap-benchmark-identity-2026.mjs's
 * job, run as a separate step against the updated corpus file.
 *
 * Usage:
 *   node scripts/ingest-frontiers-2026.mjs \
 *     --csv <path to frontiers-titlelist-web-2026.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --out <output dir> \
 *     [--concurrency 6] [--limit N] \
 *     [--excluded <path to registry/excluded-identities.csv>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { parseCsv } from '../src/showjcr/csv.mjs'
import { buildExistingIssnSet, validateConcurrency, partitionOpenAlexLookups, buildExcludedIdentitySet, validateIsoCountryCode } from '../src/migration/bulk-ingest-helpers.mjs'

const OPENALEX_BASE = 'https://api.openalex.org'
const SELECT_FIELDS = ['id', 'issn_l', 'issn', 'display_name', 'type', 'host_organization_name', 'homepage_url', 'is_oa', 'is_in_doaj', 'works_count', 'country_code']

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runBatch(items, fn, concurrency) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}

async function fetchOpenAlexSource(issn, attempt = 0) {
  try {
    const params = new URLSearchParams({ select: SELECT_FIELDS.join(','), mailto: 'posi@panorama-sg.com' })
    const res = await fetch(`${OPENALEX_BASE}/sources/issn:${encodeURIComponent(issn)}?${params.toString()}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 404) return { status: 404, source: null }
    if (!res.ok) {
      if (attempt < 2) { await sleep(500 * (attempt + 1)); return fetchOpenAlexSource(issn, attempt + 1) }
      return { status: res.status, source: null }
    }
    const data = await res.json()
    return {
      status: 200,
      source: {
        openalex_source_id: data.id ? String(data.id).replace('https://openalex.org/', '') : null,
        country_code: data.country_code ?? null,
        is_oa: data.is_oa ?? null,
        is_in_doaj: data.is_in_doaj ?? null,
        works_count: Number.isFinite(data.works_count) ? data.works_count : 0,
        host_organization_name: data.host_organization_name ?? null,
      },
    }
  } catch (err) {
    if (attempt < 2) { await sleep(500 * (attempt + 1)); return fetchOpenAlexSource(issn, attempt + 1) }
    return { status: null, source: null, error: err?.message ?? String(err) }
  }
}

const ISSN_PATTERN = /^\d{4}-\d{3}[\dXx]$/

/**
 * The CSV has an 11-line preamble (consortium metadata) before the real
 * `Journal,ISSN,URL` header -- skip to that header before parsing with
 * src/showjcr/csv.mjs's RFC4180-correct parseCsv(). The ISSN column is not
 * always a real ISSN -- e.g. row 97 is `Frontiers in Fish Science,Coming
 * Soon,...` for a not-yet-launched journal -- so validate the format
 * rather than just checking for a non-empty string (a naive truthy check
 * would silently write the literal text "Coming Soon" into issn_online).
 */
function parseFrontiersCsv(text) {
  const lines = text.split('\n')
  const headerLineIdx = lines.findIndex(l => l.startsWith('Journal,ISSN'))
  if (headerLineIdx === -1) throw new Error('Could not find "Journal,ISSN" header row in CSV')
  const { rows } = parseCsv(lines.slice(headerLineIdx).join('\n'))
  const skipped = []
  const parsed = []
  for (const r of rows) {
    const issn = (r.ISSN || '').trim()
    if (!issn) continue
    if (!ISSN_PATTERN.test(issn)) { skipped.push({ title: (r.Journal || '').trim(), issn }); continue }
    parsed.push({ issn, url: (r.URL || '').trim(), title: (r.Journal || '').trim() })
  }
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} row(s) with a non-ISSN value in the ISSN column:`)
    skipped.forEach(s => console.log(`  - ${s.title}: "${s.issn}"`))
  }
  return parsed
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function buildRecord(csvRow, openAlex, seq) {
  const now = new Date().toISOString()
  return {
    id: `j-bench-${slugify(csvRow.title)}-${String(seq).padStart(4, '0')}`,
    journal_code: `bench-${slugify(csvRow.title)}-${String(seq).padStart(4, '0')}`,
    title: csvRow.title,
    short_title: csvRow.title,
    // The consortium title list's ISSN column has no print/online marking
    // -- issn_online/issn_print stay null rather than guessing; the
    // generic value is kept as `issn` instead (see buildExistingIssnSet()'s
    // doc comment for why dedup still works).
    issn_print: null,
    issn_online: null,
    issn: csvRow.issn,
    publisher: 'Frontiers Media SA',
    country: validateIsoCountryCode(openAlex?.country_code),
    // The title list has no language column, and OpenAlex's source-level
    // lookup doesn't return one either -- null rather than assuming
    // English for the entire catalog without checking.
    language: null,
    frequency: '',
    open_access: openAlex?.is_oa ?? true,
    license: '',
    peer_review_type: '',
    website_url: csvRow.url,
    cover_image_url: null,
    oai_base_url: null,
    registration_country: null,
    doaj_status: openAlex?.is_in_doaj === true ? 'listed' : openAlex?.is_in_doaj === false ? 'not_listed' : null,
    openalex_source_id: openAlex?.openalex_source_id ?? null,
    is_external_benchmark: true,
    metadata_quality_score: 0,
    transparency_score: 0,
    indexing_readiness: 'Internal Review',
    article_count: openAlex?.works_count ?? 0,
    psc_category: null,
    psc_confidence: null,
    early_stage_rating: null,
    created_at: now,
    updated_at: now,
    source_note: 'ingested from frontiers-titlelist-web-2026.csv (Frontiers Media title list via Swiss Academic Libraries consortium), 2026-08',
  }
}

/** The `reason` column contains free text with commas -- must use the
 * real RFC4180 parser, not a naive split. */
function parseExcludedIdentitiesCsv(text) {
  const { rows } = parseCsv(text)
  return rows.map(r => ({ identity_type: r.identity_type, identity_value: r.identity_value }))
}

async function main() {
  const csvPath = resolve(arg('csv'))
  const benchmarkPath = resolve(arg('benchmark'))
  const outDir = resolve(arg('out', 'frontiers-ingest-output'))
  const concurrency = validateConcurrency(arg('concurrency', '6'))
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const excludedPath = arg('excluded')

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  let excludedIssns = new Set()
  if (excludedPath && existsSync(resolve(excludedPath))) {
    excludedIssns = buildExcludedIdentitySet(parseExcludedIdentitiesCsv(readFileSync(resolve(excludedPath), 'utf-8')))
    console.log(`Loaded ${excludedIssns.size} excluded identity value(s) from registry/excluded-identities.csv.`)
  }

  const allCsvRows = parseFrontiersCsv(readFileSync(csvPath, 'utf-8'))
  const excludedRows = allCsvRows.filter(r => excludedIssns.has(r.issn))
  const csvRows = allCsvRows.filter(r => !excludedIssns.has(r.issn))
  if (excludedRows.length > 0) {
    console.log(`Skipped ${excludedRows.length} row(s) matching a known-excluded identity:`)
    excludedRows.forEach(r => console.log(`  - ${r.title}: ${r.issn}`))
  }

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  const existingIssns = buildExistingIssnSet(benchmark)

  const allNewRows = csvRows.filter(r => !existingIssns.has(r.issn))
  const alreadyInBenchmarkCount = csvRows.length - allNewRows.length
  const newRows = limit ? allNewRows.slice(0, limit) : allNewRows
  console.log(`CSV rows: ${csvRows.length}, already in benchmark: ${alreadyInBenchmarkCount}, to ingest this run: ${newRows.length}${limit ? ` (limited from ${allNewRows.length})` : ''}`)

  let done = 0
  const lookups = await runBatch(newRows, async row => {
    const result = await fetchOpenAlexSource(row.issn)
    done++
    if (done % 50 === 0) console.log(`  ...${done}/${newRows.length} OpenAlex lookups done`)
    return { row, result }
  }, concurrency)

  const foundCount = lookups.filter(l => l.result.status === 200).length
  const notFoundCount = lookups.filter(l => l.result.status === 404).length
  const errorCount = lookups.filter(l => l.result.status !== 200 && l.result.status !== 404).length
  console.log(`OpenAlex: found ${foundCount}, not_found (404) ${notFoundCount}, error ${errorCount}`)

  const { ingestable, transientErrors } = partitionOpenAlexLookups(lookups)

  let seq = benchmark.length
  const newRecords = ingestable.map(({ row, result }) => {
    seq++
    return buildRecord(row, result.source, seq)
  })

  const updatedBenchmark = benchmark.concat(newRecords)
  writeFileSync(benchmarkPath, JSON.stringify(updatedBenchmark, null, 2) + '\n', 'utf-8')

  const summary = {
    csv_total_rows: csvRows.length,
    already_in_benchmark: alreadyInBenchmarkCount,
    remaining_not_yet_ingested: (allNewRows.length - newRows.length) + transientErrors.length,
    ingested: newRecords.length,
    openalex_found: foundCount,
    openalex_not_found_404: notFoundCount,
    openalex_transient_error_excluded: errorCount,
    new_benchmark_total: updatedBenchmark.length,
  }
  writeFileSync(join(outDir, 'ingest-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'not-found-in-openalex.csv'),
    ['issn,title'].concat(lookups.filter(l => l.result.status === 404).map(l => `${l.row.issn},"${(l.row.title || '').replace(/"/g, '""')}"`)).join('\n'),
    'utf-8'
  )
  writeFileSync(join(outDir, 'openalex-errors.csv'),
    ['issn,title,status'].concat(lookups.filter(l => l.result.status !== 200 && l.result.status !== 404).map(l => `${l.row.issn},"${(l.row.title || '').replace(/"/g, '""')}",${l.result.status}`)).join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
