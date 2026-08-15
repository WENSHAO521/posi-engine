#!/usr/bin/env node
/**
 * fetch-pjr-source-data.mjs
 *
 * PJR seed-corpus data pull (Step 3 of the pjr-seed-corpus-1000 task): for
 * each journal in a corpus file (an array of records with
 * `openalex_source_id`), fetches:
 *   1. Source-level citation-impact fields (GET /sources/{id}) — issn_l,
 *      works_count, cited_by_count, summary_stats (2yr_mean_citedness,
 *      h_index), counts_by_year.
 *   2. The PCI 2-year window (metric_year-2, metric_year-1) EXHAUSTIVELY —
 *      every work, uncapped except for EXHAUSTIVE_PAGE_CEILING's defensive
 *      backstop (see its own doc comment). PCI is the primary metric this
 *      whole pipeline exists for; its numerator must be exact, not
 *      estimated from a partial fetch, for every journal regardless of
 *      volume. type article|review only (the two OpenAlex types this
 *      project's document_type crosswalk marks citable — see
 *      src/openalex-document-type.mjs).
 *   3. The PCI-5 window's OLDER tail (metric_year-5 .. metric_year-3,
 *      deliberately excluding the 2-year window already fetched
 *      exhaustively in step 2 — no re-fetching the same works twice),
 *      capped at --max-pages (default 10, 200/page = 2000 works). PCI-5 is
 *      this pipeline's secondary metric and PJR-SPEC.md tolerates an
 *      estimated numerator for it; a journal whose true 5-year count
 *      exceeds what got fetched is marked `numerator_capped: true` so
 *      downstream metric computation can flag it rather than silently
 *      treating a partial fetch as complete. The 2-year portion of PCI-5's
 *      numerator is always exact (it's the same exhaustive fetch from step
 *      2), so only the OLDER 3 years can ever be the capped part.
 *
 *   BUG FIX (2026-08-15): the original version capped the 2-year PCI window
 *   itself at --max-pages together with the 5-year window (a single mixed
 *   fetch over metric_year-5..metric_year-1). For any journal whose 2-year
 *   citable-item count alone exceeded --max-pages*200 (e.g. JACS: 6,616 in
 *   a 2-year window against a 2,000-work default cap), the "real" PCI was
 *   silently computed from a partial, most-recent-biased subset instead of
 *   the true population — the primary metric this pipeline exists to get
 *   right. Splitting the exhaustive 2-year fetch from the capped older-tail
 *   fetch fixes this for every journal size.
 *
 * Every HTTP response is cached to disk keyed by request signature —
 * killing and re-running this script resumes without re-querying anything
 * already cached, same pattern as scripts/enrich-openalex.mjs.
 *
 * Usage:
 *   node --env-file=.env scripts/fetch-pjr-source-data.mjs \
 *     --in path/to/global-benchmark.json \
 *     --cache-dir path/to/cache \
 *     --out path/to/output.json \
 *     --metric-year 2025 \
 *     [--max-pages 10] [--concurrency 6] [--limit N]
 *
 * OPENALEX_API_KEY is required for the /works filtered-list queries this
 * script depends on — OpenAlex's /works endpoint now sits behind a paid
 * tier; the free polite pool (mailto=) is not enough on its own. Put one or
 * more `OPENALEX_API_KEY=...` lines in a .env file in this repo's root (one
 * key per line — see loadApiKeys()) and they're all round-robinned per
 * request, so several keys' separate daily budgets combine into one
 * effective budget for the run. Falls back to a single process.env
 * OPENALEX_API_KEY when no .env file exists (e.g. a GitHub Actions
 * secret). Never hardcoded, never written into any cache/output file.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'fs'
import { join, resolve } from 'path'

const OPENALEX_BASE = 'https://api.openalex.org'
const MAILTO = 'posi@panoramagroup.org'
const CITABLE_OPENALEX_TYPES = 'article|review'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

/** Each OpenAlex key carries its own separate daily $-budget, so multiple
 * keys combine into a larger effective daily budget for one run — but only
 * if something actually rotates across them. Node's `--env-file` keeps
 * just the LAST of several repeated `OPENALEX_API_KEY=` lines in a .env
 * file (every earlier one is silently dropped), so a multi-key .env has to
 * be parsed by hand here to recover all of them, rather than trusting
 * `process.env.OPENALEX_API_KEY`. Falls back to the single env-provided
 * key (e.g. a GitHub Actions secret with no local .env file) when no .env
 * file exists at all. Never logged, never written to any cache/output
 * file — only used to build request URLs.
 */
function loadApiKeys() {
  const envPath = resolve('.env')
  if (existsSync(envPath)) {
    const keys = []
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*OPENALEX_API_KEY\s*=\s*(.+?)\s*$/)
      if (m && m[1]) keys.push(m[1])
    }
    const unique = [...new Set(keys)]
    if (unique.length > 0) return unique
  }
  return process.env.OPENALEX_API_KEY ? [process.env.OPENALEX_API_KEY] : []
}

/** Round-robins across every available key, one call = one key, so a
 * multi-journal run spreads its request cost evenly across all of them
 * instead of exhausting one key's daily budget before touching the rest.
 * Coarser rotation (e.g. one key per journal) would let a single
 * high-volume journal (a JACS-scale mega-journal's exhaustive 2-year
 * fetch, dozens of requests) land entirely on one key by chance; per-call
 * rotation spreads even that across all keys. Safe to call with zero keys
 * (returns undefined, same as "no key" — every fetch function already
 * treats a falsy apiKey as "send unauthenticated").
 */
function makeKeyRotator(keys) {
  let i = 0
  return () => (keys.length === 0 ? undefined : keys[i++ % keys.length])
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function cacheKey(str) {
  // Filesystem-safe key derived from the request signature.
  return str.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180)
}

/** A cached record is safe to trust forever only if it represents a
 * PERMANENT outcome — a real success, or a real 404 (the resource
 * genuinely doesn't exist). Everything else (429 rate/budget limit
 * exhausted, 5xx, a network error that exhausted all retries) is a
 * TRANSIENT failure and must NOT be cached as final — see the BUG FIX note
 * below `isPermanentCacheRecord()`'s call site: caching a 429 forever
 * defeated this script's own advertised resumability ("killing and
 * re-running this script resumes without re-querying anything already
 * cached") for exactly the case that matters most (an OpenAlex budget/rate
 * limit that resets later) — a re-run would otherwise replay the same
 * stale failure forever instead of actually retrying once the limit lifts.
 */
function isPermanentCacheRecord(record) {
  return record.ok === true || record.status === 404
}

async function fetchJsonWithRetry(url, cacheDir, keyHint) {
  const key = cacheKey(keyHint)
  const cacheFile = join(cacheDir, `${key}.json`)
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    // BUG FIX: previously ANY cached file (including an exhausted-retry
    // 429/5xx/network failure) was trusted forever, so a re-run after an
    // OpenAlex rate/budget limit reset would silently keep returning the
    // old failure instead of retrying — see isPermanentCacheRecord().
    if (isPermanentCacheRecord(cached)) return cached
  }
  const maxAttempts = 5
  let lastError = null
  // BUG FIX: the previous version discarded the actual failure reason once
  // retries on a 429/5xx were exhausted — the cache record ended up as
  // `{ status: null, error: "null" }`, indistinguishable from a genuine
  // network failure. Track the last non-ok response's status + a snippet
  // of its body (e.g. OpenAlex's own "insufficient budget" / rate-limit
  // JSON error) so a caller can tell "retried and exhausted a real 429"
  // apart from "never got a response at all" — same distinct-reasons
  // discipline as evidence-coverage.mjs's describeFetchFailureReason().
  let lastHttpStatus = null
  let lastHttpBodySnippet = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (res.status === 404) {
        const record = { ok: false, status: 404, data: null }
        writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
        return record
      }
      if (!res.ok) {
        lastHttpStatus = res.status
        try { lastHttpBodySnippet = (await res.text()).slice(0, 300) } catch { /* body already consumed/unreadable */ }
        if (res.status === 429 || res.status >= 500) {
          await sleep(2 ** attempt * 500)
          continue
        }
        const record = { ok: false, status: res.status, data: null, body_snippet: lastHttpBodySnippet }
        writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
        return record
      }
      const data = await res.json()
      const record = { ok: true, status: 200, data }
      writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
      return record
    } catch (err) {
      lastError = err
      await sleep(2 ** attempt * 500)
    }
  }
  const record = {
    ok: false,
    status: lastHttpStatus, // e.g. 429, not null — the retries were exhausted, not "no response ever received"
    data: null,
    error: lastError?.message ?? (lastHttpStatus != null ? `exhausted ${maxAttempts} retries on HTTP ${lastHttpStatus}` : String(lastError)),
    body_snippet: lastHttpBodySnippet,
  }
  writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
  return record
}

async function runWithConcurrency(items, concurrency, worker) {
  let i = 0
  let completed = 0
  const results = new Array(items.length)
  async function next() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
      completed++
      if (completed % 50 === 0) console.log(`  ... ${completed}/${items.length} journals done`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
  return results
}

function shortSourceFields() {
  return ['id', 'issn_l', 'issn', 'works_count', 'cited_by_count', 'summary_stats', 'counts_by_year', 'display_name'].join(',')
}

function worksListUrl({ sourceId, fromYear, toYear, select, perPage, cursor, nextKey }) {
  const params = new URLSearchParams({
    filter: `primary_location.source.id:${sourceId},type:${CITABLE_OPENALEX_TYPES},publication_year:${fromYear}-${toYear}`,
    select,
    'per-page': String(perPage),
    cursor,
    mailto: MAILTO,
  })
  // Deterministic, most-recent-first order. This matters specifically for
  // journals whose true work count exceeds --max-pages: rather than an
  // unspecified/undocumented default order, publication_date:desc means a
  // capped fetch is truncated from the OLDEST end of the window first — so
  // the (flagship, more heavily weighted) most recent 2-year PCI window is
  // far more likely to be fully covered than the 5-year PCI-5 tail, even
  // for a capped journal. See numerator_capped in this script's output.
  params.set('sort', 'publication_date:desc')
  const apiKey = nextKey?.()
  if (apiKey) params.set('api_key', apiKey)
  return `${OPENALEX_BASE}/works?${params.toString()}`
}

async function fetchSource(sourceId, cacheDir, nextKey) {
  const params = new URLSearchParams({ select: shortSourceFields(), mailto: MAILTO })
  const apiKey = nextKey?.()
  if (apiKey) params.set('api_key', apiKey)
  const url = `${OPENALEX_BASE}/sources/${sourceId}?${params.toString()}`
  return fetchJsonWithRetry(url, cacheDir, `source_${sourceId}`)
}

async function fetchCitableCount(sourceId, fromYear, toYear, cacheDir, nextKey) {
  const url = worksListUrl({ sourceId, fromYear, toYear, select: 'id', perPage: 1, cursor: '*', nextKey })
  return fetchJsonWithRetry(url, cacheDir, `count_${sourceId}_${fromYear}_${toYear}`)
}

async function fetchWorksPaged(sourceId, fromYear, toYear, maxPages, cacheDir, nextKey) {
  const select = 'id,type,publication_year,counts_by_year'
  let cursor = '*'
  const works = []
  let totalCount = null
  let pages = 0
  for (let page = 0; page < maxPages; page++) {
    const url = worksListUrl({ sourceId, fromYear, toYear, select, perPage: 200, cursor, nextKey })
    const result = await fetchJsonWithRetry(url, cacheDir, `works_${sourceId}_${fromYear}_${toYear}_p${page}`)
    pages++
    if (!result.ok || !result.data) break
    if (totalCount === null) totalCount = result.data.meta?.count ?? null
    const pageResults = result.data.results ?? []
    works.push(...pageResults)
    const nextCursor = result.data.meta?.next_cursor
    if (!nextCursor || pageResults.length === 0) break
    cursor = nextCursor
  }
  return { works, totalCount, pages }
}

/** Defensive backstop for the exhaustive 2-year PCI fetch — NOT a real
 * sampling cap (same philosophy as PCS_MAX_WORKS_PER_JOURNAL in this
 * project's works-fetch.mjs). 500 pages = 100,000 works in a single
 * 2-calendar-year window is far beyond any real journal ever observed in
 * this project's corpora (PCS's own audit found Scientific Reports, the
 * single highest-volume journal in scope, at ~126,635 works across a
 * 4-YEAR window — roughly 63,000/2yr, well under this ceiling). If this
 * ever binds, that's a fetch-loop bug to investigate, not a legitimate
 * truncation — same standard as PCS_MAX_WORKS_PER_JOURNAL's own doc. */
const EXHAUSTIVE_PAGE_CEILING = 500

/** Pages through a works window with NO practical cap (see
 * EXHAUSTIVE_PAGE_CEILING) — used only for the 2-year PCI window, where the
 * numerator must be exact for every journal. Returns the same shape as
 * fetchWorksPaged() plus `hitCeiling` so a caller can tell "genuinely
 * exhausted the cursor" apart from "hit the defensive backstop" even
 * though both are rare/never-expected outcomes for the latter. */
async function fetchWorksExhaustive(sourceId, fromYear, toYear, cacheDir, nextKey) {
  const result = await fetchWorksPaged(sourceId, fromYear, toYear, EXHAUSTIVE_PAGE_CEILING, cacheDir, nextKey)
  return { ...result, hitCeiling: result.pages >= EXHAUSTIVE_PAGE_CEILING }
}

async function processJournal(journal, { cacheDir, metricYear, maxPages, nextKey }) {
  const sourceId = journal.openalex_source_id
  if (!sourceId) {
    return { journal_code: journal.journal_code, openalex_source_id: null, error: 'no openalex_source_id' }
  }

  const sourceResult = await fetchSource(sourceId, cacheDir, nextKey)

  // 2-year PCI window: exhaustive, exact numerator for every journal.
  const twoYear = await fetchWorksExhaustive(sourceId, metricYear - 2, metricYear - 1, cacheDir, nextKey)
  const twoYearExact = twoYear.totalCount

  // PCI-5's older tail (metric_year-5..metric_year-3): capped, secondary
  // metric. Deliberately excludes metric_year-2/metric_year-1 — those
  // works are already in `twoYear.works` above, so combining the two
  // arrays gives the full 5-year set without double-fetching.
  const olderTail = await fetchWorksPaged(sourceId, metricYear - 5, metricYear - 3, maxPages, cacheDir, nextKey)
  const fiveYearExactResult = await fetchCitableCount(sourceId, metricYear - 5, metricYear - 1, cacheDir, nextKey)
  const fiveYearExact = fiveYearExactResult.ok ? (fiveYearExactResult.data?.meta?.count ?? null) : null

  const works = [...twoYear.works, ...olderTail.works]
  const numeratorCapped = fiveYearExact != null && works.length < fiveYearExact

  return {
    journal_code: journal.journal_code,
    openalex_source_id: sourceId,
    source: sourceResult.ok ? sourceResult.data : null,
    source_status: sourceResult.status,
    citable_items_2yr_exact: twoYearExact,
    two_year_works_fetched: twoYear.works.length,
    two_year_hit_ceiling: twoYear.hitCeiling,
    citable_items_5yr_exact: fiveYearExact,
    works_fetched: works.length,
    numerator_capped: numeratorCapped,
    pages_fetched: twoYear.pages + olderTail.pages,
    works,
  }
}

async function main() {
  const inPath = arg('in')
  const cacheDir = resolve(arg('cache-dir', 'pjr-cache'))
  const outPath = resolve(arg('out', 'pjr-source-data.json'))
  const metricYear = parseInt(arg('metric-year', '2025'), 10)
  const maxPages = parseInt(arg('max-pages', '10'), 10)
  const concurrency = parseInt(arg('concurrency', '6'), 10)
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  // Every available OPENALEX_API_KEY (see loadApiKeys()'s doc comment for
  // why a single process.env read isn't enough for a multi-key .env),
  // round-robinned per request so a multi-key run spreads its cost across
  // all of them instead of draining one key's daily budget first. Never
  // hardcoded, never written into any output/cache file.
  const apiKeys = loadApiKeys()
  const nextKey = makeKeyRotator(apiKeys)

  if (!inPath) {
    console.error('Usage: node scripts/fetch-pjr-source-data.mjs --in <corpus.json> --out <output.json> --metric-year 2025')
    process.exit(1)
  }
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

  let journals = JSON.parse(readFileSync(resolve(inPath), 'utf-8'))
  if (limit) journals = journals.slice(0, limit)
  console.log(`Loaded ${journals.length} journals. metric_year=${metricYear}, PCI window ${metricYear - 2}-${metricYear - 1}, PCI-5 window ${metricYear - 5}-${metricYear - 1}. max_pages=${maxPages} concurrency=${concurrency}. api_keys=${apiKeys.length}`)
  if (apiKeys.length === 0) console.warn('WARNING: no OPENALEX_API_KEY found (.env or environment) — /works queries will fail without one.')

  const startTime = Date.now()
  const results = await runWithConcurrency(journals, concurrency, j => processJournal(j, { cacheDir, metricYear, maxPages, nextKey }))
  console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  const cappedCount = results.filter(r => r.numerator_capped).length
  const errorCount = results.filter(r => r.error || r.source_status !== 200).length
  console.log(`${cappedCount} journals hit the works-fetch page cap (numerator estimated from a partial fetch).`)
  console.log(`${errorCount} journals had a non-200 source lookup or other error.`)

  // NDJSON, streamed one line at a time — not a single JSON.stringify()
  // over the whole corpus, and not even a single joined string of all
  // lines. BUG FIX (2026-08-15): a 993-journal run with several JACS-scale
  // exhaustive 2-year fetches (thousands of works each, each with a
  // counts_by_year array) produced a combined object whose pretty-printed
  // (indent:2) JSON string exceeded V8's max string length (RangeError:
  // Invalid string length), losing the entire run's output after a real
  // ~74-minute, budget-spending fetch completed successfully. A plain
  // `results.map(...).join('\n')` would still build one big string first
  // and could hit the same ceiling on a large enough corpus — streaming
  // each line individually to disk has no such ceiling regardless of how
  // many journals or how large any single journal's works array is.
  const metaPath = outPath.replace(/\.json$/, '') + '.meta.json'
  writeFileSync(metaPath, JSON.stringify({ metric_year: metricYear, generated_at: new Date().toISOString(), max_pages: maxPages, journal_count: results.length }, null, 2), 'utf-8')
  const ndjsonPath = outPath.replace(/\.json$/, '') + '.ndjson'
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(ndjsonPath, { encoding: 'utf-8' })
    stream.on('error', rejectPromise)
    stream.on('finish', resolvePromise)
    for (const r of results) stream.write(JSON.stringify(r) + '\n')
    stream.end()
  })
  console.log(`Wrote ${metaPath} and ${ndjsonPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
