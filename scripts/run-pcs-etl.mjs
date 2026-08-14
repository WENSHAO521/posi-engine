#!/usr/bin/env node
/**
 * run-pcs-etl.mjs — PCS (POSI Citation Score) data-acquisition pipeline,
 * implementing PCS-1.0-SPEC.md § 8 (the fetch script the spec explicitly
 * says "is not yet built"). Ties together works-fetch.mjs's cursor-
 * pagination mechanics (PCS_SELECT_FIELDS, PCS_MAX_WORKS_PER_JOURNAL) and
 * pcs-resolver.mjs's normalization with pcs.mjs's pure calculator, against
 * a corpus file (posi-data's corpus/core-collection.json or
 * corpus/global-benchmark.json).
 *
 * Different from Article-Sample ETL v1 (run-works-etl.mjs) in exactly the
 * ways PCS-1.0-SPEC.md requires:
 *   - No ~30-article sample -- every eligible work in the journal's 4-year
 *     publication window (PCS-1.0-SPEC.md § 5), full stop.
 *   - A specific from-pub-date/until-pub-date Crossref filter (verified
 *     live against the real API, not guessed), not "most recent N works."
 *   - Extracts is-referenced-by-count (PCS_SELECT_FIELDS), which Article-
 *     Sample ETL v1 never requested.
 *   - Tracks fetch failures (pagination stoppage) separately from real
 *     zero-citation works (PCS-1.0-SPEC.md § 7) via pcs_coverage.
 *   - Document-type normalization reuses pci.mjs's isCitable() via
 *     crossref-document-type.mjs's mapCrossrefType(), the same taxonomy
 *     PCI uses -- not a second, possibly-drifting definition.
 *
 * COVERAGE GRANULARITY, disclosed honestly: this is a bulk cursor-paginated
 * list fetch (exactly what PCS-1.0-SPEC.md § 8.2 describes), not a set of
 * independent per-DOI lookups. If a page request ultimately fails (after
 * works-fetch.mjs's own retry/backoff is exhausted), pagination for that
 * journal stops at the last successfully-fetched page -- "which DOIs failed
 * to fetch" is therefore a pagination stoppage point, not a scattered list
 * of individually-failed DOIs. pcs_coverage is still exactly
 * fetchedCount/enumeratedCount per PCS-1.0-SPEC.md § 9 (enumeratedCount is
 * Crossref's own reported total-results for the from/until-pub-date filter,
 * fetchedCount is how many works were actually retrieved before any
 * stoppage) -- this note only clarifies the FAILURE GRANULARITY, not the
 * formula.
 *
 * RESUMABILITY: two on-disk layers, so a killed/interrupted run never
 * restarts from zero and never double-counts:
 *   - Per-journal completion: <out>/journals/<posi_id>.json is written only
 *     once a journal's fetch is fully resolved (success, 404, no-issn, or a
 *     definitive fetch failure). If it already exists, that journal is
 *     skipped on the next run (--force to redo it anyway).
 *   - Per-journal mid-fetch checkpoint (for large journals spanning many
 *     pages): <out>/.progress/<posi_id>.jsonl is an APPEND-ONLY log, one
 *     line per successfully-fetched page's raw items -- appending (not
 *     rewriting the whole accumulated array every page) keeps checkpoint
 *     I/O cost linear in total pages, not quadratic. <out>/.progress/
 *     <posi_id>.state.json is a small file overwritten each page with the
 *     next cursor to resume from. On start, if a .state.json exists and is
 *     not yet done, the run reads the .jsonl back to reconstruct already-
 *     fetched items and resumes pagination from the saved cursor instead of
 *     re-fetching pages already on disk.
 *
 * Usage:
 *   node scripts/run-pcs-etl.mjs \
 *     --corpus <path to corpus/core-collection.json> \
 *     [--corpus <path to corpus/global-benchmark.json> --benchmark-curated-only] \
 *     --out <output dir> \
 *     [--metric-year 2026] [--limit N] [--concurrency 4] [--delay-ms 200] \
 *     [--rows 1000] [--force]
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { fetchCrossrefWorksPage, PCS_SELECT_FIELDS, PCS_MAX_WORKS_PER_JOURNAL } from '../src/works-fetch.mjs'
import { normalizeCrossrefWorkForPcs, isInPcsWindow, pcsWindowForMetricYear } from '../src/pcs-resolver.mjs'
import { calculatePcs, calculatePcsCoverage, PCS_METHODOLOGY_VERSION } from '../src/pcs.mjs'
import { shardFor } from '../src/sharding.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
function flag(name) { return process.argv.includes(`--${name}`) }
function args(name) {
  const out = []
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1])
  return out
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function journalIssn(journal) {
  return journal.issn_online ?? journal.issn_print ?? null
}

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

// ---------------------------------------------------------------------
// Resumability sidecars
// ---------------------------------------------------------------------

function progressPaths(progressDir, posiId) {
  return {
    jsonl: join(progressDir, `${posiId}.jsonl`),
    state: join(progressDir, `${posiId}.state.json`),
  }
}

function loadProgress(progressDir, posiId) {
  const { jsonl, state } = progressPaths(progressDir, posiId)
  if (!existsSync(state)) return null
  const stateObj = JSON.parse(readFileSync(state, 'utf-8'))
  if (stateObj.done) return null // a leftover state file for an already-finalized journal -- ignore
  let items = []
  if (existsSync(jsonl)) {
    const lines = readFileSync(jsonl, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) items = items.concat(JSON.parse(line).items)
  }
  return { cursor: stateObj.nextCursor, pagesFetched: stateObj.pagesFetched, totalResults: stateObj.totalResults, items }
}

function saveProgressPage(progressDir, posiId, { page, items, nextCursor, totalResults, pagesFetched }) {
  ensureDir(progressDir)
  const { jsonl, state } = progressPaths(progressDir, posiId)
  appendFileSync(jsonl, JSON.stringify({ page, items }) + '\n', 'utf-8')
  writeFileSync(state, JSON.stringify({ nextCursor, totalResults, pagesFetched, done: false }), 'utf-8')
}

function clearProgress(progressDir, posiId) {
  const { jsonl, state } = progressPaths(progressDir, posiId)
  try { if (existsSync(jsonl)) unlinkSync(jsonl) } catch { /* best-effort cleanup */ }
  try { if (existsSync(state)) unlinkSync(state) } catch { /* best-effort cleanup */ }
}

// ---------------------------------------------------------------------
// Per-journal fetch: bulk cursor pagination over the 4-year window
// ---------------------------------------------------------------------

/**
 * @returns {{
 *   status: number|null, error: string|null, totalResults: number|null,
 *   rawItems: object[], pagesFetched: number,
 * }}
 */
async function fetchJournalWindow(issn, { startYear, endYear, rows, progressDir, posiId, delayMs, mailto }) {
  const filter = `from-pub-date:${startYear}-01-01,until-pub-date:${endYear}-12-31`
  const resumed = loadProgress(progressDir, posiId)
  let cursor = resumed?.cursor ?? '*'
  let items = resumed?.items ?? []
  let totalResults = resumed?.totalResults ?? null
  let pagesFetched = resumed?.pagesFetched ?? 0
  const startedFresh = !resumed

  if (!startedFresh) {
    console.log(`    resuming ${posiId} from checkpoint: ${items.length} items already fetched across ${pagesFetched} pages`)
  }

  for (;;) {
    const page = await fetchCrossrefWorksPage(issn, {
      cursor, rows, filter, sort: 'created', order: 'asc', selectFields: PCS_SELECT_FIELDS, mailto,
    })
    if (page.status !== 200) {
      // Pagination stops here -- whatever was already fetched (and
      // checkpointed) is kept; this journal's pcs_coverage will honestly
      // reflect the shortfall (PCS-1.0-SPEC.md § 7/§ 9).
      return { status: page.status, error: page.error, totalResults: totalResults ?? page.totalResults, rawItems: items, pagesFetched }
    }
    pagesFetched++
    totalResults = page.totalResults
    items = items.concat(page.items)
    const exhausted = page.items.length === 0 || !page.nextCursor || items.length >= PCS_MAX_WORKS_PER_JOURNAL
    saveProgressPage(progressDir, posiId, { page: pagesFetched, items: page.items, nextCursor: page.nextCursor, totalResults, pagesFetched })
    if (exhausted) return { status: 200, error: null, totalResults, rawItems: items, pagesFetched }
    cursor = page.nextCursor
    if (delayMs > 0) await sleep(delayMs)
  }
}

function emptyResult(journal, metricYear, window, note) {
  return {
    posi_id: journal.posi_id, journal_code: journal.journal_code, title: journal.title,
    metric_year: metricYear, pcs_window_start_year: window.startYear, pcs_window_end_year: window.endYear,
    issn_queried: null, fetch_status: null, fetch_error: null,
    enumerated_count: null, works_fetched: 0, pages_fetched: 0,
    pcs: null, pcs_eligible_items: 0, pcs_citation_count: 0, pcs_items_with_citation_data: 0,
    pcs_coverage: null, excluded_outside_window: 0,
    pcs_source: 'crossref', pcs_source_retrieved_at: new Date().toISOString().slice(0, 10),
    pcs_methodology_version: PCS_METHODOLOGY_VERSION,
    note,
  }
}

async function processJournal(journal, { metricYear, window, rows, progressDir, delayMs, mailto }) {
  const issn = journalIssn(journal)
  if (!issn) return emptyResult(journal, metricYear, window, 'no issn_online or issn_print on record -- nothing to query Crossref with')

  const fetchResult = await fetchJournalWindow(issn, { startYear: window.startYear, endYear: window.endYear, rows, progressDir, posiId: journal.posi_id, delayMs, mailto })

  if (fetchResult.status !== 200 && fetchResult.rawItems.length === 0) {
    return {
      ...emptyResult(journal, metricYear, window, fetchResult.status === 404
        ? 'Crossref has no works registered under this ISSN'
        : `Crossref fetch did not succeed: status=${fetchResult.status} error=${fetchResult.error}`),
      issn_queried: issn, fetch_status: fetchResult.status, fetch_error: fetchResult.error,
      enumerated_count: fetchResult.totalResults, pages_fetched: fetchResult.pagesFetched,
    }
  }

  const normalized = fetchResult.rawItems.map(normalizeCrossrefWorkForPcs)
  const inWindow = normalized.filter(w => isInPcsWindow(w, window.startYear, window.endYear))
  const excludedOutsideWindow = normalized.length - inWindow.length

  const pcsResult = calculatePcs(inWindow)
  const enumeratedCount = fetchResult.totalResults
  const coverage = calculatePcsCoverage(fetchResult.rawItems.length, enumeratedCount)

  return {
    posi_id: journal.posi_id, journal_code: journal.journal_code, title: journal.title,
    metric_year: metricYear, pcs_window_start_year: window.startYear, pcs_window_end_year: window.endYear,
    issn_queried: issn, fetch_status: fetchResult.status, fetch_error: fetchResult.error,
    enumerated_count: enumeratedCount, works_fetched: fetchResult.rawItems.length, pages_fetched: fetchResult.pagesFetched,
    pcs: pcsResult.pcs, pcs_eligible_items: pcsResult.eligible_items, pcs_citation_count: pcsResult.citation_count,
    pcs_items_with_citation_data: pcsResult.items_with_citation_data,
    pcs_coverage: coverage, excluded_outside_window: excludedOutsideWindow,
    pcs_source: 'crossref', pcs_source_retrieved_at: new Date().toISOString().slice(0, 10),
    pcs_methodology_version: PCS_METHODOLOGY_VERSION,
    note: fetchResult.status !== 200
      ? `partial fetch -- pagination stopped early (status=${fetchResult.status} error=${fetchResult.error}); pcs_coverage reflects the real shortfall, not a completed fetch`
      : null,
  }
}

/** The metric.schema.json-declared PCS subset only (§ 9) -- intentionally
 * NOT a full metric.schema.json record. metric.schema.json's `required`
 * array also demands citable_items/methodology_version/status, which are
 * PCI-derived fields this pipeline never computes (PCI has not been run
 * for these journals) -- fabricating placeholder values for those fields
 * to force schema validity would be exactly the kind of invented number
 * this project's discipline forbids. See the PCS ETL audit README for how
 * this is meant to be merged into a real metric snapshot later. */
function toSchemaSubset(result) {
  return {
    journal_id: result.posi_id,
    metric_year: result.metric_year,
    pcs: result.pcs,
    pcs_window_start_year: result.pcs_window_start_year,
    pcs_window_end_year: result.pcs_window_end_year,
    pcs_eligible_items: result.pcs_eligible_items,
    pcs_items_with_citation_data: result.pcs_items_with_citation_data,
    pcs_coverage: result.pcs_coverage,
    pcs_source: result.pcs_source,
    pcs_source_retrieved_at: result.pcs_source_retrieved_at,
    pcs_methodology_version: result.pcs_methodology_version,
  }
}

async function runBatch(items, fn, concurrency) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    results.push(...await Promise.all(batch.map(fn)))
  }
  return results
}

async function main() {
  const corpusPaths = args('corpus').filter(Boolean)
  const outDir = resolve(arg('out', 'pcs-etl-output'))
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const concurrency = parseInt(arg('concurrency', '4'), 10)
  const delayMs = parseInt(arg('delay-ms', '200'), 10)
  const rows = parseInt(arg('rows', '1000'), 10)
  const metricYear = parseInt(arg('metric-year', String(new Date().getFullYear())), 10)
  const mailto = arg('mailto', 'posi@panorama-sg.com')
  const force = flag('force')
  const benchmarkCuratedOnly = flag('benchmark-curated-only')

  if (corpusPaths.length === 0) {
    console.error('Usage: node scripts/run-pcs-etl.mjs --corpus <path> [--corpus <path> ...] --out <dir> [--metric-year 2026] [--limit N] [--concurrency 4] [--delay-ms 200] [--rows 1000] [--force] [--benchmark-curated-only]')
    process.exit(1)
  }

  const window = pcsWindowForMetricYear(metricYear)
  console.log(`PCS metric_year=${metricYear}, window=${window.startYear}-${window.endYear} (PCS-1.0-SPEC.md § 5)`)

  let corpus = []
  for (const p of corpusPaths) {
    const raw = JSON.parse(readFileSync(resolve(p), 'utf-8'))
    let list = Array.isArray(raw) ? raw : (raw.journals ?? [])
    if (benchmarkCuratedOnly) {
      // posi-data's own sync-corpus.mjs convention: curated Global Benchmark
      // entries are the ones WITHOUT a source_note field (the ones with
      // source_note are a different, non-curated provenance).
      const before = list.length
      list = list.filter(j => !j.source_note)
      console.log(`  ${p}: ${before} total, ${list.length} curated (no source_note)`)
    } else {
      console.log(`  ${p}: ${list.length} journals`)
    }
    corpus = corpus.concat(list)
  }
  const seen = new Set()
  corpus = corpus.filter(j => {
    if (!j.posi_id || seen.has(j.posi_id)) return false
    seen.add(j.posi_id)
    return true
  })
  const targets = limit ? corpus.slice(0, limit) : corpus
  console.log(`Loaded ${corpus.length} unique journals total${limit ? `, processing first ${targets.length}` : ''}`)

  const journalsOutDir = join(outDir, 'journals')
  const pcsOutDir = join(outDir, 'pcs')
  const progressDir = join(outDir, '.progress')
  ensureDir(journalsOutDir)
  ensureDir(pcsOutDir)
  ensureDir(progressDir)

  let skipped = 0
  const results = []
  let processedSoFar = 0

  async function runOne(j) {
    const donePath = join(journalsOutDir, `${j.posi_id}.json`)
    if (!force && existsSync(donePath)) {
      skipped++
      return JSON.parse(readFileSync(donePath, 'utf-8'))
    }
    let result
    try {
      result = await processJournal(j, { metricYear, window, rows, progressDir, delayMs, mailto })
    } catch (err) {
      // Same isolation discipline as run-works-etl.mjs: one journal's
      // unexpected failure must never abort the whole batch run.
      result = { ...emptyResult(j, metricYear, window, `unexpected error, isolated: ${err?.message ?? err}`) }
    }
    writeFileSync(donePath, JSON.stringify(result, null, 2), 'utf-8')
    const shard = shardFor(j.posi_id)
    const shardDir = join(pcsOutDir, shard)
    ensureDir(shardDir)
    writeFileSync(join(shardDir, `${j.posi_id}.json`), JSON.stringify(toSchemaSubset(result), null, 2), 'utf-8')
    clearProgress(progressDir, j.posi_id)
    processedSoFar++
    console.log(`[${processedSoFar}/${targets.length - skipped}+${skipped} skipped] ${j.title} (${j.posi_id}) issn=${result.issn_queried ?? 'none'} status=${result.fetch_status} enumerated=${result.enumerated_count} fetched=${result.works_fetched} eligible=${result.pcs_eligible_items} pcs=${result.pcs != null ? result.pcs.toFixed(2) : 'null'} coverage=${result.pcs_coverage != null ? (result.pcs_coverage * 100).toFixed(1) + '%' : 'null'}`)
    return result
  }

  const allResults = await runBatch(targets, runOne, concurrency)
  results.push(...allResults)

  const summary = {
    metric_year: metricYear,
    pcs_window_start_year: window.startYear,
    pcs_window_end_year: window.endYear,
    input_journals: targets.length,
    skipped_already_done: skipped,
    journals_with_issn: results.filter(r => r.issn_queried).length,
    journals_with_no_issn: results.filter(r => !r.issn_queried).length,
    journals_with_crossref_404: results.filter(r => r.fetch_status === 404).length,
    journals_with_complete_fetch: results.filter(r => r.fetch_status === 200 && r.pcs_coverage === 1).length,
    journals_with_partial_fetch: results.filter(r => r.fetch_status === 200 && r.pcs_coverage != null && r.pcs_coverage < 1).length,
    journals_with_zero_eligible_items: results.filter(r => r.pcs_eligible_items === 0).length,
    journals_with_pcs_computed: results.filter(r => r.pcs != null).length,
    total_works_fetched: results.reduce((s, r) => s + (r.works_fetched ?? 0), 0),
    total_eligible_items: results.reduce((s, r) => s + (r.pcs_eligible_items ?? 0), 0),
    total_citation_count: results.reduce((s, r) => s + (r.pcs_citation_count ?? 0), 0),
    mean_pcs_coverage: (() => {
      const withCoverage = results.filter(r => r.pcs_coverage != null)
      return withCoverage.length > 0 ? withCoverage.reduce((s, r) => s + r.pcs_coverage, 0) / withCoverage.length : null
    })(),
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'per-journal-pcs.csv'),
    ['posi_id,title,issn_queried,fetch_status,enumerated_count,works_fetched,pages_fetched,pcs_eligible_items,pcs_citation_count,pcs,pcs_coverage']
      .concat(results.map(r => `${r.posi_id},"${(r.title ?? '').replace(/"/g, '""')}",${r.issn_queried ?? ''},${r.fetch_status ?? ''},${r.enumerated_count ?? ''},${r.works_fetched},${r.pages_fetched},${r.pcs_eligible_items},${r.pcs_citation_count},${r.pcs ?? ''},${r.pcs_coverage ?? ''}`))
      .join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
