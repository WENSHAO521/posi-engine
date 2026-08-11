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
 *   2. An exact citable-items count for the PCI 2-year window (metric_year-2,
 *      metric_year-1), via a per_page=1 meta.count-only query filtered to
 *      OpenAlex type article|review (the only two OpenAlex types this
 *      project's document_type crosswalk marks citable — see
 *      src/openalex-document-type.mjs).
 *   3. Individual works (id, type, publication_year, counts_by_year) for the
 *      PCI-5 5-year window (metric_year-5 .. metric_year-1), same type
 *      filter, paginated up to --max-pages (default 10, 200/page = 2000
 *      works). meta.count on the FIRST page is recorded as the exact 5-year
 *      citable_items count regardless of how many pages are actually
 *      fetched — only the per-work numerator data (counts_by_year, needed
 *      to compute citations received IN metric_year) is capped, and a
 *      journal whose true count exceeds what got fetched is marked
 *      `numerator_capped: true` so downstream metric computation can flag
 *      it rather than silently treating a partial fetch as complete.
 *
 * Every HTTP response is cached to disk keyed by request signature —
 * killing and re-running this script resumes without re-querying anything
 * already cached, same pattern as scripts/enrich-openalex.mjs.
 *
 * Usage:
 *   node scripts/fetch-pjr-source-data.mjs \
 *     --in path/to/global-benchmark.json \
 *     --cache-dir path/to/cache \
 *     --out path/to/output.json \
 *     --metric-year 2025 \
 *     [--max-pages 10] [--concurrency 6] [--limit N]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'

const OPENALEX_BASE = 'https://api.openalex.org'
const MAILTO = 'posi@panoramagroup.org'
const CITABLE_OPENALEX_TYPES = 'article|review'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function cacheKey(str) {
  // Filesystem-safe key derived from the request signature.
  return str.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180)
}

async function fetchJsonWithRetry(url, cacheDir, keyHint) {
  const key = cacheKey(keyHint)
  const cacheFile = join(cacheDir, `${key}.json`)
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'))
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

function worksListUrl({ sourceId, fromYear, toYear, select, perPage, cursor }) {
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
  return `${OPENALEX_BASE}/works?${params.toString()}`
}

async function fetchSource(sourceId, cacheDir) {
  const url = `${OPENALEX_BASE}/sources/${sourceId}?select=${shortSourceFields()}&mailto=${MAILTO}`
  return fetchJsonWithRetry(url, cacheDir, `source_${sourceId}`)
}

async function fetchCitableCount(sourceId, fromYear, toYear, cacheDir) {
  const url = worksListUrl({ sourceId, fromYear, toYear, select: 'id', perPage: 1, cursor: '*' })
  return fetchJsonWithRetry(url, cacheDir, `count_${sourceId}_${fromYear}_${toYear}`)
}

async function fetchWorksPaged(sourceId, fromYear, toYear, maxPages, cacheDir) {
  const select = 'id,type,publication_year,counts_by_year'
  let cursor = '*'
  const works = []
  let totalCount = null
  let pages = 0
  for (let page = 0; page < maxPages; page++) {
    const url = worksListUrl({ sourceId, fromYear, toYear, select, perPage: 200, cursor })
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

async function processJournal(journal, { cacheDir, metricYear, maxPages }) {
  const sourceId = journal.openalex_source_id
  if (!sourceId) {
    return { journal_code: journal.journal_code, openalex_source_id: null, error: 'no openalex_source_id' }
  }

  const sourceResult = await fetchSource(sourceId, cacheDir)
  const twoYearCountResult = await fetchCitableCount(sourceId, metricYear - 2, metricYear - 1, cacheDir)
  const { works, totalCount: fiveYearCount, pages } = await fetchWorksPaged(sourceId, metricYear - 5, metricYear - 1, maxPages, cacheDir)

  const numeratorCapped = fiveYearCount != null && works.length < fiveYearCount

  return {
    journal_code: journal.journal_code,
    openalex_source_id: sourceId,
    source: sourceResult.ok ? sourceResult.data : null,
    source_status: sourceResult.status,
    citable_items_2yr_exact: twoYearCountResult.ok ? (twoYearCountResult.data?.meta?.count ?? null) : null,
    citable_items_5yr_exact: fiveYearCount,
    works_fetched: works.length,
    numerator_capped: numeratorCapped,
    pages_fetched: pages,
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

  if (!inPath) {
    console.error('Usage: node scripts/fetch-pjr-source-data.mjs --in <corpus.json> --out <output.json> --metric-year 2025')
    process.exit(1)
  }
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })

  let journals = JSON.parse(readFileSync(resolve(inPath), 'utf-8'))
  if (limit) journals = journals.slice(0, limit)
  console.log(`Loaded ${journals.length} journals. metric_year=${metricYear}, PCI window ${metricYear - 2}-${metricYear - 1}, PCI-5 window ${metricYear - 5}-${metricYear - 1}. max_pages=${maxPages} concurrency=${concurrency}`)

  const startTime = Date.now()
  const results = await runWithConcurrency(journals, concurrency, j => processJournal(j, { cacheDir, metricYear, maxPages }))
  console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  const cappedCount = results.filter(r => r.numerator_capped).length
  const errorCount = results.filter(r => r.error || r.source_status !== 200).length
  console.log(`${cappedCount} journals hit the works-fetch page cap (numerator estimated from a partial fetch).`)
  console.log(`${errorCount} journals had a non-200 source lookup or other error.`)

  writeFileSync(outPath, JSON.stringify({ metric_year: metricYear, generated_at: new Date().toISOString(), max_pages: maxPages, journals: results }, null, 2), 'utf-8')
  console.log(`Wrote ${outPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
