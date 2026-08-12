#!/usr/bin/env node
/**
 * ingest-jnlactive-elsevier-2026.mjs
 *
 * Adds the Elsevier journals listed in posi-data's jnlactive.csv (Elsevier's
 * own active-journals export: Full Title, ISSN, Unformatted ISSN, Product
 * ID, Shortcut URL) that are NOT YET present in corpus/global-benchmark.json
 * (matched by ISSN) as new benchmark records, enriched via OpenAlex's free
 * singleton per-ISSN lookup (GET /sources/issn:{issn} -- unmetered, unlike
 * the filtered/list endpoint that blocked PCI computation earlier this
 * project).
 *
 * Does NOT mint POSI-J ids -- that is scripts/remap-benchmark-identity-2026.mjs's
 * job, run as a separate step against the updated corpus file, so identity
 * resolution stays in exactly one place (reuse-before-mint against the
 * current registry).
 *
 * Usage:
 *   node scripts/ingest-jnlactive-elsevier-2026.mjs \
 *     --csv <path to jnlactive.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --out <output dir> \
 *     [--concurrency 6] [--limit N] \
 *     [--excluded <path to registry/excluded-identities.csv>]
 *
 * --excluded skips rows matching a known-bad identity value (e.g. a
 * "ghost" ISSN with no real external evidence, caught and documented in a
 * prior run -- see registry/excluded-identities.csv) so it doesn't
 * resurface as a fresh "unresolved, needs manual review" candidate every
 * time the source CSV still contains it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { parseCsv } from '../src/showjcr/csv.mjs'
import { buildExistingIssnSet, validateConcurrency, partitionOpenAlexLookups, buildExcludedIdentitySet } from '../src/migration/bulk-ingest-helpers.mjs'

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

/** Singleton per-ISSN OpenAlex lookup -- same endpoint/shape as
 * posi-engine/src/migration/openalex-enrich.mjs's fetchOpenAlexSourceByIssn(),
 * with country_code added since this ingestion needs it and the shared
 * module (used elsewhere, kept minimal on purpose) doesn't select it. */
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

/**
 * Uses src/showjcr/csv.mjs's RFC4180-correct parseCsv() -- NOT a naive
 * split(',') -- because jnlactive.csv has quoted titles containing commas
 * (e.g. `"Chaos, Solitons & Fractals",0960-0779,...`). A naive comma-split
 * shifts every column after a comma-containing title, which either
 * produces an obviously-empty ISSN (caught) or, worse, silently reads a
 * neighboring column's value into the ISSN field (not caught by any
 * validation, a real corruption risk). Caught in review after an initial
 * run using a naive split minted ids for corrupted rows -- rolled back,
 * rewritten to use the real parser before minting anything for real.
 */
function parseJnlactiveCsv(text) {
  const { rows } = parseCsv(text)
  return rows
    .filter(r => r.ISSN)
    .map(r => ({ issn: r.ISSN.trim(), url: (r['Shortcut URL'] || '').trim(), title: r['Full Title'] }))
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
    issn_print: null,
    issn_online: csvRow.issn,
    publisher: 'Elsevier BV',
    country: openAlex?.country_code ?? null,
    language: 'English',
    frequency: '',
    open_access: openAlex?.is_oa ?? false,
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
    source_note: 'ingested from jnlactive.csv (Elsevier active-journals export), 2026-08',
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
  const outDir = resolve(arg('out', 'jnlactive-ingest-output'))
  const concurrency = validateConcurrency(arg('concurrency', '6'))
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const excludedPath = arg('excluded')

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  let excludedIssns = new Set()
  if (excludedPath && existsSync(resolve(excludedPath))) {
    excludedIssns = buildExcludedIdentitySet(parseExcludedIdentitiesCsv(readFileSync(resolve(excludedPath), 'utf-8')))
    console.log(`Loaded ${excludedIssns.size} excluded identity value(s) from registry/excluded-identities.csv.`)
  }

  const allCsvRows = parseJnlactiveCsv(readFileSync(csvPath, 'utf-8'))
  const excludedRows = allCsvRows.filter(r => excludedIssns.has(r.issn))
  const csvRows = allCsvRows.filter(r => !excludedIssns.has(r.issn))
  if (excludedRows.length > 0) {
    console.log(`Skipped ${excludedRows.length} row(s) matching a known-excluded identity (see registry/excluded-identities.csv):`)
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
    if (done % 100 === 0) console.log(`  ...${done}/${newRows.length} OpenAlex lookups done`)
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
