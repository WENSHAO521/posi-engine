#!/usr/bin/env node
/**
 * compute-benchmark-citation-preview-2026.mjs
 *
 * Supersedes compute-benchmark-citation-q-2026.mjs (2026-08-12/13), which
 * this hotfix withdraws. That script fed OpenAlex's `summary_stats.
 * 2yr_mean_citedness` into `quartile-tracks.mjs`'s `rankCitationTrack()`
 * as if it were `pci`, producing a real `citation_q.rank/percentile/
 * quartile` for 2,614 Global Benchmark journals. Two direct conflicts
 * with already-frozen methodology, found on review:
 *
 *   1. AJR-SPEC.md §14 ("Global Benchmark membership is not ranking
 *      eligibility"): real ranking eligibility requires collection
 *      eligibility + lifecycle + PSC high/verified confidence + Evidence
 *      Coverage eligibility + a real cohort gate. This script's `mature`
 *      bucket is an admitted heuristic (counts_by_year shows activity
 *      >=5 years back) -- explicitly NOT the real FPD-1.0/LIFECYCLE-1.1
 *      determination -- and no Evidence Coverage crawl ran at all.
 *   2. rankCitationTrack()'s own contract takes `{ journal_id, pci }` --
 *      PCI is POSI's own citable-items/citation-window calculation
 *      (PJR-SPEC.md §5-6), not OpenAlex's 2yr_mean_citedness. Labeling
 *      the OpenAlex figure's rank/percentile "Citation Q1-4" borrowed the
 *      real metric's name for a different number.
 *
 * This script computes the same PSC classification + lifecycle-bucket
 * heuristic + raw OpenAlex citedness figure, but stops there: no cohort
 * grouping, no rankCategory() call, no rank/percentile/quartile of any
 * kind. Output is explicitly `status: "diagnostic_only"` and is not
 * intended to be read as, or ever silently promoted into, a real Citation
 * Q. See posi-data's audits/migrations/benchmark-citation-q-2026/README.md
 * for the superseded-run writeup, and
 * audits/migrations/citation-preview-correction-2026/ for this fix.
 *
 * Usage:
 *   node scripts/compute-benchmark-citation-preview-2026.mjs \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --cache-dir <dir> \
 *     --out <output dir> \
 *     [--concurrency 8] [--limit N] [--min-mature-year-lookback 5]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { classifyPsc } from '../src/psc-classify.mjs'

const OPENALEX_BASE = 'https://api.openalex.org'
const MAILTO = 'posi@panorama-sg.com'
export const CITATION_PREVIEW_VERSION = 'CITATION-PREVIEW-1.0'

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
  return fetchJsonWithRetry(url, cacheDir, `citprev_source_${sourceId}`)
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
  const cacheDir = resolve(arg('cache-dir', 'citation-preview-cache'))
  const outDir = resolve(arg('out', 'citation-preview-output'))
  const concurrency = parseInt(arg('concurrency', '8'), 10)
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const lookback = parseInt(arg('min-mature-year-lookback', '5'), 10)
  const thisYear = new Date().getUTCFullYear()

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  // Only journals with no real evidence-based rating -- never overwrites a
  // genuine early_stage_rating (curated seed's ~1000 records all have one).
  let candidates = benchmark.filter(j => j.early_stage_rating == null)
  if (limit) candidates = candidates.slice(0, limit)
  console.log(`Benchmark total: ${benchmark.length}. Candidates (no early_stage_rating): ${candidates.length}${limit ? ` (limited to ${candidates.length})` : ''}.`)

  const results = await runWithConcurrency(candidates, concurrency, j => processJournal(j, { cacheDir, thisYear, lookback }))

  const errored = results.filter(r => r.error)
  const classified = results.filter(r => !r.error)
  console.log(`OpenAlex fetch errors: ${errored.length}. Classified: ${classified.length}.`)

  const today = new Date().toISOString().slice(0, 10)
  const finalRecords = new Map()
  for (const r of results) {
    if (r.error) {
      finalRecords.set(r.journal_code, { citation_preview: null, error: r.error })
      continue
    }
    finalRecords.set(r.journal_code, {
      citation_preview: {
        source: 'OpenAlex',
        metric: '2yr_mean_citedness',
        value: r.two_yr_mean_citedness,
        h_index: r.h_index,
        works_count: r.works_count,
        psc_category: r.psc_category,
        psc_confidence: r.psc_confidence,
        history_evidence: {
          // NOT the real FPD-1.0/LIFECYCLE-1.1 determination -- a
          // conservative proxy: real, checkable evidence of publishing
          // activity >=5 years back, or its absence. Never treated as a
          // lifecycle-stage assignment.
          has_activity_5y_ago: r.lifecycle_bucket === 'mature',
        },
        // Deliberately null, always. This is a diagnostic preview, not a
        // ranking -- no cohort was built, no rankCategory()/
        // rankCitationTrack() call happens anywhere in this script. See
        // module header for why the previous version's rank/percentile/
        // quartile output was withdrawn.
        rank: null,
        percentile: null,
        quartile: null,
        status: 'diagnostic_only',
        rated_at: today,
        version: CITATION_PREVIEW_VERSION,
        source_note: 'Diagnostic preview only -- OpenAlex 2yr mean citedness, not PCI. Not ranked, not Citation Q, not used for any POSI ranking or eligibility decision.',
      },
    })
  }

  const summary = {
    generated_at: new Date().toISOString(),
    this_year: thisYear,
    candidates: candidates.length,
    openalex_fetch_errors: errored.length,
    classified: classified.length,
    mature_bucket: classified.filter(r => r.lifecycle_bucket === 'mature').length,
    not_yet_mature_bucket: classified.filter(r => r.lifecycle_bucket === 'not_yet_mature').length,
    high_confidence_psc: classified.filter(r => r.psc_confidence === 'high' && r.psc_category).length,
    note: 'No rank/percentile/quartile computed by this script, by design. See CITATION_PREVIEW_VERSION and each record\'s status field.',
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'results-by-journal-code.json'), JSON.stringify(Object.fromEntries(finalRecords), null, 2), 'utf-8')
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
