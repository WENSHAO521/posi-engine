#!/usr/bin/env node
/**
 * run-evidence-etl.mjs — Evidence ETL v1 orchestrator. Ties together
 * evidence-fetch.mjs / evidence-page-discovery.mjs / evidence-resolver.mjs
 * / evidence-publisher-registry.mjs / evidence-coverage.mjs into a real
 * crawl run against a corpus file (posi-data's corpus/core-collection.json
 * or corpus/global-benchmark.json).
 *
 * Full candidate-path sweep (not an early-exit-once-enough-is-found
 * crawl) — deliberately more requests than strictly necessary per
 * journal, because this run's purpose is diagnostic: characterizing the
 * real fetch/resolve failure modes (which paths 403, which journals are
 * mostly blocked, how coverage is actually distributed) before scaling up
 * to the full 1000-journal Global Benchmark Collection. A production
 * steady-state run would reasonably switch to early-exit.
 *
 * Does NOT write to corpus/*.json or compute AJR-E/AJR-M scores — this
 * script's output is Evidence, not a rating. Wiring evidence into AJR-E/
 * AJR-M is a separate, later step, after this run's evidence is reviewed.
 *
 * Usage:
 *   node scripts/run-evidence-etl.mjs \
 *     --corpus <path to corpus/core-collection.json> \
 *     --publisher-registry <path to evidence/publishers dir, optional> \
 *     --out <output dir> \
 *     [--limit N] [--concurrency 4] [--delay-ms 500]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fetchWithStatus, isPathDisallowedByRobots } from '../src/evidence-fetch.mjs'
import { candidateUrls, discoverLinks } from '../src/evidence-page-discovery.mjs'
import { resolveAllCriteria, EVIDENCE_CRITERIA } from '../src/evidence-resolver.mjs'
import { applyPublisherInheritance } from '../src/evidence-publisher-registry.mjs'
import { evidenceCoverage, dimensionScore, ratingEligibility, EVIDENCE_COVERAGE_METHODOLOGY_VERSION } from '../src/evidence-coverage.mjs'

const USER_AGENT = 'POSI-EvidenceETL/1.0 (+https://posi.panorama-sg.com; posi@panorama-sg.com)'
const MAX_PAGES_PER_JOURNAL = 30

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runBatch(items, fn, concurrency, delayMs) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    results.push(...await Promise.all(batch.map(fn)))
    if (i + concurrency < items.length) await sleep(delayMs)
  }
  return results
}

function loadPublisherRegistry(dir) {
  if (!dir || !existsSync(dir)) return []
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  return files.flatMap(f => {
    try {
      const content = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
      return Array.isArray(content) ? content : [content]
    } catch {
      return []
    }
  })
}

async function fetchRobotsDisallowChecker(baseWebsiteUrl, concurrency, delayMs) {
  const base = baseWebsiteUrl.replace(/\/+$/, '')
  const result = await fetchWithStatus(`${base}/robots.txt`, { timeoutMs: 8000, userAgent: USER_AGENT })
  const robotsTxt = result.fetch_status === 'ok' ? result.body : ''
  return path => isPathDisallowedByRobots(robotsTxt, path, USER_AGENT)
}

async function crawlJournal(journal, { concurrency, delayMs }) {
  const posiId = journal.posi_id
  const websiteUrl = journal.website_url

  if (!websiteUrl) {
    return {
      posi_id: posiId, journal_code: journal.journal_code, title: journal.title,
      website_url: null, fetched_pages: [], evidence_items: [],
      coverage: { coverage_percent: 0, applicable_weight: 0, resolved_weight: 0, met_weight: 0, not_applicable_weight: 0 },
      rating_eligibility: 'not_rateable', mandatory_evidence_resolved: false,
      note: 'no website_url on record -- nothing to crawl',
    }
  }

  const isDisallowed = await fetchRobotsDisallowChecker(websiteUrl, concurrency, delayMs)

  const candidates = candidateUrls(websiteUrl)
  const toFetch = []
  const robotsBlockedUrls = []
  for (const url of candidates) {
    const path = url.replace(new URL(websiteUrl).origin, '') || '/'
    if (isDisallowed(path)) robotsBlockedUrls.push(url)
    else toFetch.push(url)
  }

  let fetchedPages = await runBatch(
    toFetch,
    url => fetchWithStatus(url, { timeoutMs: 10000, userAgent: USER_AGENT }),
    concurrency, delayMs
  )
  for (const url of robotsBlockedUrls) {
    fetchedPages.push({ url, fetch_status: 'robots_blocked', http_status: null, body: null, retrieved_at: new Date().toISOString(), error: null })
  }

  // Link discovery from the homepage (and /about, if separately fetched) --
  // catches publisher-specific slugs CANDIDATE_PATHS didn't anticipate.
  const seedPages = fetchedPages.filter(p => p.fetch_status === 'ok' && p.body)
  const discovered = new Set()
  for (const page of seedPages.slice(0, 3)) {
    for (const link of discoverLinks(page.body, websiteUrl)) discovered.add(link)
  }
  const alreadyFetched = new Set(fetchedPages.map(p => p.url))
  const newLinks = [...discovered].filter(u => !alreadyFetched.has(u)).slice(0, Math.max(0, MAX_PAGES_PER_JOURNAL - fetchedPages.length))
  if (newLinks.length > 0) {
    const discoveredResults = await runBatch(
      newLinks,
      url => fetchWithStatus(url, { timeoutMs: 10000, userAgent: USER_AGENT }),
      concurrency, delayMs
    )
    fetchedPages = fetchedPages.concat(discoveredResults)
  }

  let evidenceItems = resolveAllCriteria(fetchedPages)
  evidenceItems = applyPublisherInheritance(evidenceItems, journal.publisher, [])

  const coverage = evidenceCoverage(evidenceItems)
  // v1 mandatory bar: identity + ISSN present (always true for a corpus
  // record) and at least one page fetched successfully. The framework's
  // full mandatory-evidence list (AJR-SPEC.md § 6) also includes lifecycle
  // classification and article-sample adequacy, which belong to the AJR-E/
  // AJR-M scoring step, not this Evidence-only pass -- left for that step
  // to check, not duplicated here.
  const mandatoryEvidenceResolved = fetchedPages.some(p => p.fetch_status === 'ok')
  const eligibility = ratingEligibility(coverage.coverage_percent, mandatoryEvidenceResolved)

  const dimensions = ['editorial_governance', 'research_integrity', 'transparency']
  const dimensionScores = {}
  for (const dim of dimensions) {
    const items = evidenceItems.filter(i => EVIDENCE_CRITERIA.find(c => c.id === i.id)?.dimension === dim)
    dimensionScores[dim] = dimensionScore(items, items.reduce((s, i) => s + i.weight, 0))
  }

  return {
    posi_id: posiId,
    journal_code: journal.journal_code,
    title: journal.title,
    website_url: websiteUrl,
    fetched_pages: fetchedPages.map(p => ({ url: p.url, fetch_status: p.fetch_status, http_status: p.http_status })),
    evidence_items: evidenceItems,
    dimension_scores: dimensionScores,
    coverage,
    rating_eligibility: eligibility,
    mandatory_evidence_resolved: mandatoryEvidenceResolved,
    evidence_methodology_version: EVIDENCE_COVERAGE_METHODOLOGY_VERSION,
    snapshot_date: new Date().toISOString().slice(0, 10),
  }
}

function bucketCoverage(pct) {
  if (pct === 100) return '100%'
  if (pct >= 90) return '90-99%'
  if (pct >= 80) return '80-89%'
  if (pct >= 60) return '60-79%'
  return '<60%'
}

async function main() {
  const corpusPath = resolve(arg('corpus'))
  const outDir = resolve(arg('out', 'evidence-etl-output'))
  const publisherRegistryDir = arg('publisher-registry')
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const concurrency = parseInt(arg('concurrency', '4'), 10)
  const delayMs = parseInt(arg('delay-ms', '500'), 10)

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const journalsOutDir = join(outDir, 'journals')
  if (!existsSync(journalsOutDir)) mkdirSync(journalsOutDir, { recursive: true })

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'))
  const targets = limit ? corpus.slice(0, limit) : corpus
  console.log(`Loaded ${corpus.length} journals from ${corpusPath}${limit ? ` (processing first ${targets.length})` : ''}`)

  const registry = loadPublisherRegistry(publisherRegistryDir)
  console.log(`Publisher registry: ${registry.length} entries loaded`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i]
    process.stdout.write(`[${i + 1}/${targets.length}] ${j.title} (${j.posi_id ?? 'NO POSI_ID'}) ... `)
    const result = await crawlJournal(j, { concurrency, delayMs })
    results.push(result)
    writeFileSync(join(journalsOutDir, `${result.posi_id ?? j.journal_code}.json`), JSON.stringify(result, null, 2), 'utf-8')
    console.log(`coverage ${result.coverage.coverage_percent}% -> ${result.rating_eligibility} (${result.fetched_pages.length} pages fetched)`)
  }

  // --- Coverage distribution + error-mode summary ---
  const distribution = { '100%': 0, '90-99%': 0, '80-89%': 0, '60-79%': 0, '<60%': 0 }
  let blockedCount = 0, notFoundCount = 0, conflictedCount = 0, staleCount = 0, unknownCount = 0
  for (const r of results) {
    distribution[bucketCoverage(r.coverage.coverage_percent)]++
    for (const item of r.evidence_items) {
      if (item.status === 'blocked') blockedCount++
      if (item.status === 'unknown') unknownCount++
      if (item.status === 'conflicted') conflictedCount++
      if (item.status === 'stale') staleCount++
    }
    for (const p of r.fetched_pages) {
      if (p.fetch_status === 'not_found') notFoundCount++
    }
  }

  const summary = {
    input_journals: targets.length,
    journals_with_website_url: results.filter(r => r.website_url).length,
    journals_with_no_website_url: results.filter(r => !r.website_url).length,
    total_pages_fetched: results.reduce((s, r) => s + r.fetched_pages.length, 0),
    total_pages_ok: results.reduce((s, r) => s + r.fetched_pages.filter(p => p.fetch_status === 'ok').length, 0),
    coverage_distribution: distribution,
    rating_eligibility_breakdown: {
      official: results.filter(r => r.rating_eligibility === 'official').length,
      provisional: results.filter(r => r.rating_eligibility === 'provisional').length,
      not_rateable: results.filter(r => r.rating_eligibility === 'not_rateable').length,
    },
    evidence_item_status_counts: {
      blocked: blockedCount, unknown: unknownCount, conflicted: conflictedCount, stale: staleCount,
    },
    fetch_404_count: notFoundCount,
    mean_coverage_percent: Math.round((results.reduce((s, r) => s + r.coverage.coverage_percent, 0) / results.length) * 100) / 100,
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'per-journal-coverage.csv'),
    ['posi_id,title,coverage_percent,rating_eligibility,pages_fetched,pages_ok']
      .concat(results.map(r => `${r.posi_id},"${(r.title ?? '').replace(/"/g, '""')}",${r.coverage.coverage_percent},${r.rating_eligibility},${r.fetched_pages.length},${r.fetched_pages.filter(p => p.fetch_status === 'ok').length}`))
      .join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
