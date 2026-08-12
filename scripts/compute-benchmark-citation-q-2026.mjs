#!/usr/bin/env node
/**
 * compute-benchmark-citation-q-2026.mjs
 *
 * For every Global Benchmark journal that doesn't yet have a real
 * evidence-based AJR score (early_stage_rating is null on the bulk-
 * ingested Elsevier/Frontiers records -- see audits/migrations/), computes
 * a *provisional* Citation Q ranking and writes it to a new
 * `citation_rating` field. Deliberately does NOT touch `early_stage_rating`
 * -- that field is reserved for a real evidence-based AJR-E/AJR-M score
 * (per its own documented contract in the website's types.ts), and running
 * a full evidence crawl across ~4000 journals (most on major-publisher
 * platforms already known to block ~73% of requests, per the Core
 * Collection Evidence ETL v1 finding) is not attempted here.
 *
 * What IS computed, and how, mirrors the site's own existing
 * /citation-reports page exactly: OpenAlex's `summary_stats.
 * 2yr_mean_citedness` as a *provisional* citation figure, explicitly
 * labeled "not yet official PCI" (the real PJR-computed PCI needs a
 * formal release per PJR-SPEC.md, not done for Core Collection either
 * yet) -- not a new, heavier per-article citation-window computation.
 * This keeps the claim honest without requiring the expensive per-work
 * OpenAlex pagination fetch-pjr-source-data.mjs uses for the real PCI/
 * PCI-5 pipeline.
 *
 * Per journal, a single OpenAlex singleton source lookup fetches:
 *   - topics                 -> psc-classify.mjs's classifyPsc()
 *   - summary_stats           -> two_yr_mean_citedness, h_index (provisional citation figure)
 *   - works_count             -> psc-classify.mjs's confidence gate
 *   - counts_by_year          -> lifecycle bucket heuristic (see below)
 *
 * Lifecycle bucket (NOT the real FPD-1.0/LIFECYCLE-1.1 methodology, which
 * needs an actual first-publication-date resolution -- see
 * src/first-publication-date.mjs/src/lifecycle.mjs, unused here on
 * purpose): a journal is bucketed "mature" only if OpenAlex's
 * counts_by_year shows at least one non-zero entry >= 5 years before this
 * run's year -- real, checkable evidence of being 60+ months old, not an
 * assumption. Absence of such evidence buckets a journal "not_yet_mature"
 * (conservatively -- POSI's own "unknown is not the favorable case"
 * principle applies here the same as everywhere else), never "unknown".
 *
 * Every HTTP response is cached to disk (same pattern as
 * fetch-pjr-source-data.mjs) so an interrupted run resumes cleanly.
 *
 * Usage:
 *   node scripts/compute-benchmark-citation-q-2026.mjs \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --cache-dir <dir> \
 *     --out <output dir> \
 *     [--concurrency 8] [--limit N] [--min-mature-year-lookback 5]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { classifyPsc } from '../src/psc-classify.mjs'
import { rankCitationTrack } from '../src/quartile-tracks.mjs'

const OPENALEX_BASE = 'https://api.openalex.org'
const MAILTO = 'posi@panorama-sg.com'
const CITATION_RATING_VERSION = 'CITATION-Q-PROVISIONAL-1.0'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function cacheKey(str) {
  return str.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180)
}

function isPermanentCacheRecord(record) {
  return record.ok === true || record.status === 404
}

async function fetchJsonWithRetry(url, cacheDir, keyHint) {
  const key = cacheKey(keyHint)
  const cacheFile = join(cacheDir, `${key}.json`)
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    if (isPermanentCacheRecord(cached)) return cached
  }
  const maxAttempts = 5
  let lastHttpStatus = null
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
        if (res.status === 429 || res.status >= 500) { await sleep(2 ** attempt * 500); continue }
        const record = { ok: false, status: res.status, data: null }
        writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
        return record
      }
      const data = await res.json()
      const record = { ok: true, status: 200, data }
      writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
      return record
    } catch {
      await sleep(2 ** attempt * 500)
    }
  }
  const record = { ok: false, status: lastHttpStatus, data: null, error: `exhausted ${maxAttempts} retries` }
  writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
  return record
}

async function runWithConcurrency(items, concurrency, worker) {
  let i = 0, completed = 0
  const results = new Array(items.length)
  async function next() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
      completed++
      if (completed % 100 === 0) console.log(`  ... ${completed}/${items.length} journals done`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
  return results
}

function sourceFields() {
  return ['id', 'works_count', 'summary_stats', 'counts_by_year', 'topics'].join(',')
}

async function fetchSource(sourceId, cacheDir) {
  const url = `${OPENALEX_BASE}/sources/${sourceId}?select=${sourceFields()}&mailto=${MAILTO}`
  return fetchJsonWithRetry(url, cacheDir, `citq_source_${sourceId}`)
}

function isMature(countsByYear, thisYear, lookback) {
  if (!Array.isArray(countsByYear)) return false
  return countsByYear.some(c => c.year <= thisYear - lookback && (c.works_count ?? 0) > 0)
}

async function processJournal(journal, { cacheDir, thisYear, lookback }) {
  const sourceId = journal.openalex_source_id
  if (!sourceId) {
    return { journal_code: journal.journal_code, error: 'no_openalex_source_id' }
  }
  const result = await fetchSource(sourceId, cacheDir)
  if (!result.ok || !result.data) {
    return { journal_code: journal.journal_code, error: `openalex_fetch_failed_status_${result.status}` }
  }
  const d = result.data
  const psc = classifyPsc(d.topics, d.works_count)
  const mature = isMature(d.counts_by_year, thisYear, lookback)
  return {
    journal_code: journal.journal_code,
    psc_category: psc.psc_category,
    psc_confidence: psc.psc_confidence,
    lifecycle_bucket: mature ? 'mature' : 'not_yet_mature',
    two_yr_mean_citedness: d.summary_stats?.['2yr_mean_citedness'] ?? null,
    h_index: d.summary_stats?.h_index ?? null,
    works_count: d.works_count ?? null,
  }
}

async function main() {
  const benchmarkPath = resolve(arg('benchmark'))
  const cacheDir = resolve(arg('cache-dir', 'citation-q-cache'))
  const outDir = resolve(arg('out', 'citation-q-output'))
  const concurrency = parseInt(arg('concurrency', '8'), 10)
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const lookback = parseInt(arg('min-mature-year-lookback', '5'), 10)
  const thisYear = new Date().getUTCFullYear()

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  // Only journals with no real evidence-based rating yet -- never overwrites
  // a genuine early_stage_rating (curated seed's 993 records all have one).
  let candidates = benchmark.filter(j => j.early_stage_rating == null)
  if (limit) candidates = candidates.slice(0, limit)
  console.log(`Benchmark total: ${benchmark.length}. Candidates (no early_stage_rating): ${candidates.length}${limit ? ` (limited to ${candidates.length})` : ''}.`)

  const results = await runWithConcurrency(candidates, concurrency, j => processJournal(j, { cacheDir, thisYear, lookback }))

  const errored = results.filter(r => r.error)
  const classified = results.filter(r => !r.error)
  console.log(`OpenAlex fetch errors: ${errored.length}. Classified: ${classified.length}.`)

  const matureHighConf = classified.filter(r => r.lifecycle_bucket === 'mature' && r.psc_confidence === 'high' && r.psc_category && r.two_yr_mean_citedness != null)
  const byCategory = new Map()
  for (const r of matureHighConf) {
    if (!byCategory.has(r.psc_category)) byCategory.set(r.psc_category, [])
    byCategory.get(r.psc_category).push(r)
  }

  const rankingByCode = new Map()
  for (const [category_code, entries] of byCategory) {
    const rankInput = entries.map(e => ({ journal_id: e.journal_code, pci: e.two_yr_mean_citedness }))
    const ranked = rankCitationTrack(rankInput, { category_code, metric_year: thisYear })
    for (const r of ranked) rankingByCode.set(r.journal_id, r)
  }

  const today = new Date().toISOString().slice(0, 10)
  const finalRecords = new Map()
  for (const r of results) {
    if (r.error) {
      finalRecords.set(r.journal_code, {
        citation_rating: null,
        error: r.error,
      })
      continue
    }
    const ranking = rankingByCode.get(r.journal_code) ?? null
    finalRecords.set(r.journal_code, {
      citation_rating: {
        psc_category: r.psc_category,
        psc_confidence: r.psc_confidence,
        lifecycle_bucket: r.lifecycle_bucket,
        two_yr_mean_citedness: r.two_yr_mean_citedness,
        h_index: r.h_index,
        works_count: r.works_count,
        citation_q: ranking ? {
          quartile: ranking.quartile,
          quartile_label: ranking.quartile_label,
          percentile: ranking.percentile,
          rank: ranking.rank,
          cohort_size: ranking.category_size,
          ranking_method: ranking.ranking_method,
          category_code: ranking.category_code,
        } : null,
        rated_at: today,
        version: CITATION_RATING_VERSION,
        source_note: 'Provisional -- OpenAlex 2yr mean citedness, not yet official PJR PCI. See /citation-reports.',
      },
    })
  }

  const summary = {
    generated_at: new Date().toISOString(),
    this_year: thisYear,
    candidates: candidates.length,
    openalex_fetch_errors: errored.length,
    classified: classified.length,
    mature_high_confidence_classified: matureHighConf.length,
    categories_formed: byCategory.size,
    ranked_with_quartile: [...rankingByCode.values()].filter(r => r.ranking_method === 'pci_midrank').length,
    ranking_unavailable_cohort_too_small: [...rankingByCode.values()].filter(r => r.ranking_method === 'unavailable').length,
    mature_unclassified_or_low_confidence: classified.filter(r => r.lifecycle_bucket === 'mature' && !(r.psc_confidence === 'high' && r.psc_category)).length,
    not_yet_mature: classified.filter(r => r.lifecycle_bucket === 'not_yet_mature').length,
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'results-by-journal-code.json'), JSON.stringify(Object.fromEntries(finalRecords), null, 2), 'utf-8')
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
