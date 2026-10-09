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
 *     [--rows 1000] [--force] [--shard i/N] [--budget-minutes M] [--recheck-issns] [--require-cells]
 *
 * PARALLEL SHARDS: --shard i/N keeps only the journals whose posi_id hashes
 * to shard i of N (stable across runs), so N machines can each take one
 * shard of a large corpus and write to their own --out; the per-journal
 * files are then merged into one directory (they never overlap).
 * --budget-minutes stops starting new journals after M minutes; journals
 * in flight finish, and everything left resumes on the next run.
 *
 * ISSN FALLBACK: a journal is fetched under its first ISSN, and under the
 * next only when an ISSN has no works in the window (see issnsToTry); the
 * ISSNs passed over are kept in issns_without_works. A journal with no works
 * under any ISSN gets no PCS and is not ranked. --recheck-issns applies the
 * fallback to journals recorded with no works before it existed.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { createHash } from 'crypto'
import { fetchCrossrefWorksPage, crossrefRequestStats, PCS_SELECT_FIELDS, PCS_MAX_WORKS_PER_JOURNAL } from '../src/works-fetch.mjs'
import { normalizeCrossrefWorkForPcs, isInPcsWindow, pcsWindowForMetricYear } from '../src/pcs-resolver.mjs'
import { calculatePcs, calculatePcsCoverage, PCS_METHODOLOGY_VERSION } from '../src/pcs.mjs'
import { isCitable } from '../src/pci.mjs'
import { cellsFromItems } from '../src/pnci.mjs'
import { shardFor } from '../src/sharding.mjs'
import { withoutWithdrawn } from '../src/withdrawn.mjs'

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

/** Every ISSN on the record, the preferred one (issn_online) first. */
function journalIssns(journal) {
  return [...new Set([journal.issn_online, journal.issn_print, ...(journal.issns ?? [])].filter(Boolean))]
}


/**
 * The ISSNs to fetch a journal under, in order. A journal's first ISSN (its
 * ISSN-L) is sometimes a ceased or print-only ISSN with no current works
 * (The Lancet: ISSN-L 0099-5355 has none from 2022; 0140-6736 has 6,228).
 * processJournal fetches under the first and moves to the next only when an
 * ISSN has no works in the window; a journal none of whose ISSNs has works
 * is recorded without a PCS and left unranked. Journals whose first ISSN
 * has works cost no extra request.
 */
function issnsToTry(journal, skip = []) {
  return journalIssns(journal).filter(i => !skip.includes(i))
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

function loadProgress(progressDir, posiId, issn) {
  const { jsonl, state } = progressPaths(progressDir, posiId)
  if (!existsSync(state)) return null
  const stateObj = JSON.parse(readFileSync(state, 'utf-8'))
  if (stateObj.done) return null // a leftover state file for an already-finalized journal -- ignore
  if (stateObj.issn && stateObj.issn !== issn) { clearProgress(progressDir, posiId); return null } // fetched under another ISSN
  let items = []
  if (existsSync(jsonl)) {
    const lines = readFileSync(jsonl, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) items = items.concat(JSON.parse(line).items)
  }
  return { cursor: stateObj.nextCursor, pagesFetched: stateObj.pagesFetched, totalResults: stateObj.totalResults, items }
}

function saveProgressPage(progressDir, posiId, { page, items, nextCursor, totalResults, pagesFetched, issn }) {
  ensureDir(progressDir)
  const { jsonl, state } = progressPaths(progressDir, posiId)
  appendFileSync(jsonl, JSON.stringify({ page, items }) + '\n', 'utf-8')
  writeFileSync(state, JSON.stringify({ nextCursor, totalResults, pagesFetched, done: false, issn }), 'utf-8')
}

function clearProgress(progressDir, posiId) {
  const { jsonl, state } = progressPaths(progressDir, posiId)
  try { if (existsSync(jsonl)) unlinkSync(jsonl) } catch { /* best-effort cleanup */ }
  try { if (existsSync(state)) unlinkSync(state) } catch { /* best-effort cleanup */ }
}

// ---------------------------------------------------------------------
// Per-journal fetch: bulk cursor pagination over the 4-year window
// ---------------------------------------------------------------------

/** How many times to retry a SUSPICIOUSLY-empty page (200 status, zero
 * items, but the journal's own already-fetched item count is still short
 * of Crossref's own reported total-results) before accepting it as real
 * exhaustion. Discovered as a real, reproducible issue during the full
 * 1024-journal run (see the PCS ETL global audit's "cursor anomaly"
 * section): 3 journals stopped early with a 200/empty page under
 * concurrency=8 load, but a same-cursor retry moments later returned the
 * correct remaining page in full -- this is not the well-understood,
 * legitimate cursor-exhaustion signal fetchAllCrossrefWorks() (works-fetch.mjs)
 * relies on elsewhere; it looks like a transient artifact of concurrent
 * load against Crossref's cursor/scroll context rather than a genuine end
 * of results. A LEGITIMATE end-of-results empty page (totalResults already
 * fully accounted for) is never retried here -- only the specific
 * still-short-of-total-results case is. */
const SUSPICIOUS_EMPTY_PAGE_MAX_RETRIES = 3
const SUSPICIOUS_EMPTY_PAGE_RETRY_DELAY_MS = 1500

/**
 * @returns {{
 *   status: number|null, error: string|null, totalResults: number|null,
 *   rawItems: object[], pagesFetched: number,
 * }}
 */
async function fetchJournalWindow(issn, { startYear, endYear, rows, progressDir, posiId, delayMs, mailto }) {
  const filter = `from-pub-date:${startYear}-01-01,until-pub-date:${endYear}-12-31`
  const resumed = loadProgress(progressDir, posiId, issn)
  let cursor = resumed?.cursor ?? '*'
  let items = resumed?.items ?? []
  let totalResults = resumed?.totalResults ?? null
  let pagesFetched = resumed?.pagesFetched ?? 0
  const startedFresh = !resumed

  if (!startedFresh) {
    console.log(`    resuming ${posiId} from checkpoint: ${items.length} items already fetched across ${pagesFetched} pages`)
  }

  for (;;) {
    let page = await fetchCrossrefWorksPage(issn, {
      cursor, rows, filter, sort: 'created', order: 'asc', selectFields: PCS_SELECT_FIELDS, mailto,
    })
    if (page.status !== 200) {
      // Pagination stops here -- whatever was already fetched (and
      // checkpointed) is kept; this journal's pcs_coverage will honestly
      // reflect the shortfall (PCS-1.0-SPEC.md § 7/§ 9).
      return { status: page.status, error: page.error, totalResults: totalResults ?? page.totalResults, rawItems: items, pagesFetched }
    }

    // Suspicious-empty-page retry: a 200 with zero items normally means
    // real exhaustion (fetchAllCrossrefWorks()'s existing, correct
    // semantics), but ONLY when it's consistent with Crossref's own
    // reported total-results. If items.length===0 while we're still short
    // of totalResults, retry the identical cursor a few times before
    // accepting it.
    if (page.items.length === 0 && page.totalResults != null && items.length < page.totalResults) {
      for (let attempt = 1; attempt <= SUSPICIOUS_EMPTY_PAGE_MAX_RETRIES && page.items.length === 0; attempt++) {
        await sleep(SUSPICIOUS_EMPTY_PAGE_RETRY_DELAY_MS)
        page = await fetchCrossrefWorksPage(issn, {
          cursor, rows, filter, sort: 'created', order: 'asc', selectFields: PCS_SELECT_FIELDS, mailto,
        })
        if (page.status !== 200) {
          return { status: page.status, error: page.error, totalResults: totalResults ?? page.totalResults, rawItems: items, pagesFetched }
        }
      }
    }

    pagesFetched++
    totalResults = page.totalResults
    items = items.concat(page.items)
    const exhausted = page.items.length === 0 || !page.nextCursor || items.length >= PCS_MAX_WORKS_PER_JOURNAL
    saveProgressPage(progressDir, posiId, { page: pagesFetched, items: page.items, nextCursor: page.nextCursor, totalResults, pagesFetched, issn })
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

async function processJournal(journal, { metricYear, window, rows, progressDir, delayMs, mailto, skipIssns = [] }) {
  const candidates = issnsToTry(journal, skipIssns)
  if (!candidates.length) return emptyResult(journal, metricYear, window, 'no issn_online or issn_print on record -- nothing to query Crossref with')

  // Fetch under the first ISSN; move to the next only when one has no works
  // in the window (404 or zero results). A failed request stops here and is
  // retried as a transient failure, never skipped past.
  const tried = [...skipIssns]
  let issn, fetchResult
  for (const candidate of candidates) {
    issn = candidate
    fetchResult = await fetchJournalWindow(issn, { startYear: window.startYear, endYear: window.endYear, rows, progressDir, posiId: journal.posi_id, delayMs, mailto })
    const empty = fetchResult.status === 404 || (fetchResult.status === 200 && fetchResult.rawItems.length === 0 && !fetchResult.totalResults)
    if (!empty) break
    tried.push(issn)
    clearProgress(progressDir, journal.posi_id)
  }
  const issnsTried = tried.filter(i => i !== issn)

  if (fetchResult.status !== 200 && fetchResult.rawItems.length === 0) {
    return {
      ...emptyResult(journal, metricYear, window, fetchResult.status === 404
        ? 'Crossref has no works registered under this ISSN'
        : `Crossref fetch did not succeed: status=${fetchResult.status} error=${fetchResult.error}`),
      issn_queried: issn, issns_without_works: issnsTried, fetch_status: fetchResult.status, fetch_error: fetchResult.error,
      enumerated_count: fetchResult.totalResults, pages_fetched: fetchResult.pagesFetched,
    }
  }

  const normalized = fetchResult.rawItems.map(normalizeCrossrefWorkForPcs)
  const inWindow = normalized.filter(w => isInPcsWindow(w, window.startYear, window.endYear))
  const excludedOutsideWindow = normalized.length - inWindow.length

  const pcsResult = calculatePcs(inWindow)
  // PNCI-1.0 input (posi-data/PNCI-1.0-SPEC.md): the eligible items' citation
  // counts by publication year and document type, as histograms. Kept in the
  // per-journal result only; the PCS subset below is unchanged.
  const cells = cellsFromItems(inWindow.filter(isCitable))
  const enumeratedCount = fetchResult.totalResults
  const coverage = calculatePcsCoverage(fetchResult.rawItems.length, enumeratedCount)

  return {
    posi_id: journal.posi_id, journal_code: journal.journal_code, title: journal.title,
    metric_year: metricYear, pcs_window_start_year: window.startYear, pcs_window_end_year: window.endYear,
    issn_queried: issn, issns_without_works: issnsTried, fetch_status: fetchResult.status, fetch_error: fetchResult.error,
    enumerated_count: enumeratedCount, works_fetched: fetchResult.rawItems.length, pages_fetched: fetchResult.pagesFetched,
    pcs: pcsResult.pcs, pcs_eligible_items: pcsResult.eligible_items, pcs_citation_count: pcsResult.citation_count,
    pcs_items_with_citation_data: pcsResult.items_with_citation_data,
    pcs_coverage: coverage, excluded_outside_window: excludedOutsideWindow,
    pcs_source: 'crossref', pcs_source_retrieved_at: new Date().toISOString().slice(0, 10),
    pcs_methodology_version: PCS_METHODOLOGY_VERSION,
    cells,
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

/** Attempts (across passes and runs) before a transient failure is recorded as final. */
const TRANSIENT_MAX_ATTEMPTS = 3

/** Network errors, timeouts, rate limiting and server errors: worth trying again later.
 * 404 (no works under the ISSN), other 4xx and a missing ISSN are real answers. */
function isTransientFailure(result) {
  if (!result.issn_queried) return false
  const s = result.fetch_status
  return s == null || s === 408 || s === 429 || s >= 500
}

/** Stable shard of a journal id: 0..count-1. */
function shardOf(posiId, count) {
  return createHash('md5').update(posiId).digest().readUInt32BE(0) % count
}

// A worker pool: each worker takes the next journal as soon as its last one
// is done, so one large journal no longer holds up a whole batch. After the
// deadline no new journal is started.
async function runPool(items, fn, concurrency, deadline) {
  const results = []
  let next = 0
  async function worker() {
    while (next < items.length && Date.now() < deadline) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { results: results.filter(Boolean), started: next }
}

async function main() {
  const startedAt = Date.now()
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
  const recheckIssns = flag('recheck-issns')
  // --require-cells: a journal finished before PNCI-1.0 (a result with works
  // but no per-item `cells`) is fetched again, so PNCI can be computed for it.
  const requireCells = flag('require-cells')
  const shardArg = arg('shard')
  const [shardIndex, shardCount] = shardArg ? shardArg.split('/').map(Number) : [0, 1]
  if (!(shardCount >= 1 && shardIndex >= 0 && shardIndex < shardCount)) { console.error(`bad --shard ${shardArg} (expected i/N)`); process.exit(1) }
  const deadline = arg('budget-minutes') ? Date.now() + Number(arg('budget-minutes')) * 60_000 : Infinity

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
  corpus = withoutWithdrawn(corpus)
  if (shardCount > 1) corpus = corpus.filter(j => shardOf(j.posi_id, shardCount) === shardIndex)
  const targets = limit ? corpus.slice(0, limit) : corpus
  console.log(`Loaded ${corpus.length} unique journals${shardCount > 1 ? ` in shard ${shardIndex}/${shardCount}` : ' total'}${limit ? `, processing first ${targets.length}` : ''}`)

  const journalsOutDir = join(outDir, 'journals')
  const pcsOutDir = join(outDir, 'pcs')
  const progressDir = join(outDir, '.progress')
  const retryDir = join(outDir, 'retry')
  ensureDir(retryDir)
  ensureDir(journalsOutDir)
  ensureDir(pcsOutDir)
  ensureDir(progressDir)

  let skipped = 0
  const results = []
  let processedSoFar = 0

  async function runOne(j) {
    const donePath = join(journalsOutDir, `${j.posi_id}.json`)
    let skipIssns = []
    if (!force && existsSync(donePath)) {
      const done = JSON.parse(readFileSync(donePath, 'utf-8'))
      // --recheck-issns: a journal recorded with no works under its first
      // ISSN, before the fallback existed, is tried under its other ISSNs.
      const noWorks = done.fetch_status === 404 || (done.fetch_status === 200 && !done.enumerated_count)
      const untried = recheckIssns && noWorks && !done.issns_without_works && done.issn_queried ? issnsToTry(j, [done.issn_queried]) : []
      const missingCells = requireCells && !done.cells && (done.pcs_eligible_items ?? 0) > 0
      if (!untried.length && !missingCells) {
        skipped++
        return done
      }
      if (untried.length) {
        skipIssns = [done.issn_queried]
        console.log(`  recheck ${j.posi_id}: no works under ${done.issn_queried}; trying ${untried.join(', ')}`)
      } else {
        console.log(`  refetch ${j.posi_id}: no per-item cells for PNCI-1.0`)
      }
    }
    let result
    try {
      result = await processJournal(j, { metricYear, window, rows, progressDir, delayMs, mailto, skipIssns })
    } catch (err) {
      // Same isolation discipline as run-works-etl.mjs: one journal's
      // unexpected failure must never abort the whole batch run.
      result = { ...emptyResult(j, metricYear, window, `unexpected error, isolated: ${err?.message ?? err}`), issn_queried: journalIssn(j) }
    }
    // A transient failure (network, timeout, rate limit, server error) is not
    // a result: the journal stays open and is tried again by a later pass or
    // run, up to TRANSIENT_MAX_ATTEMPTS times, and only then recorded as is.
    if (isTransientFailure(result)) {
      const retryPath = join(retryDir, `${j.posi_id}.json`)
      const attempts = (existsSync(retryPath) ? JSON.parse(readFileSync(retryPath, 'utf-8')).attempts : 0) + 1
      clearProgress(progressDir, j.posi_id) // Crossref cursors expire; a retry starts the journal afresh
      if (attempts < TRANSIENT_MAX_ATTEMPTS) {
        writeFileSync(retryPath, JSON.stringify({ attempts, last_status: result.fetch_status, last_error: result.fetch_error ?? result.note, at: new Date().toISOString() }))
        processedSoFar++
        console.log(`[${processedSoFar}/${targets.length - skipped}+${skipped} skipped] ${j.title} (${j.posi_id}) transient failure (status=${result.fetch_status}), attempt ${attempts} of ${TRANSIENT_MAX_ATTEMPTS}; will retry`)
        return null
      }
      result.note = `${result.note ? result.note + '; ' : ''}gave up after ${attempts} attempts with transient failures`
    }
    if (existsSync(join(retryDir, `${j.posi_id}.json`))) unlinkSync(join(retryDir, `${j.posi_id}.json`))
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

  const { results: allResults, started } = await runPool(targets, runOne, concurrency, deadline)
  if (started < targets.length) console.log(`Time budget reached: ${targets.length - started} journals left for the next run`)
  const pendingRetry = targets.length - allResults.length - (targets.length - started)
  if (pendingRetry > 0) console.log(`${pendingRetry} journals had transient failures and will be retried`)
  // Not push(...allResults): spreading ~158,000 items overflows the call stack.
  for (const r of allResults) results.push(r)

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
    // This run's Crossref traffic: if rate_limited is a large share of
    // requests, the run is limited by Crossref and more shards will not help.
    crossref_requests: crossrefRequestStats.requests,
    crossref_rate_limited: crossrefRequestStats.rate_limited,
    crossref_rate_limit_wait_minutes: Math.round(crossrefRequestStats.rate_limit_wait_ms / 600) / 100,
    run_minutes: Math.round((Date.now() - startedAt) / 600) / 100,
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
