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
 * script's output is site evidence only, not a rating. This module
 * deliberately does NOT call evidence-coverage.mjs's ratingEligibility():
 * that function's `mandatoryEvidenceResolved` contract means the FULL
 * AJR-E mandatory bar (journal identity, ISSN, launch date, lifecycle,
 * article sample, PSC, integrity status — AJR-SPEC.md § 6), none of which
 * this Evidence-only pass computes. Calling it with "at least one page
 * fetched OK" as a stand-in would produce an `official`/`provisional`/
 * `not_rateable` label that looks like a real AJR-E eligibility
 * determination but isn't one — a review caught this as a real defect in
 * an earlier version of this script. This script reports
 * `site_evidence_coverage_percent` instead; computing the real
 * `rating_status` is the AJR-E/AJR-M scoring step's job, once lifecycle +
 * PSC + article-sample data also exist for a journal.
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
import { evidenceCoverage, dimensionScore, EVIDENCE_COVERAGE_METHODOLOGY_VERSION } from '../src/evidence-coverage.mjs'

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

/**
 * robots.txt always lives at the site ORIGIN root, never under an OJS
 * install's base path (e.g. https://example.com/index.php/journal) --
 * fetching `${websiteUrl}/robots.txt` for such a journal would request
 * `.../index.php/journal/robots.txt`, which is not robots.txt at all.
 * Review-caught bug in an earlier version of this script.
 */
async function fetchRobotsDisallowChecker(baseWebsiteUrl) {
  const origin = new URL(baseWebsiteUrl).origin
  const result = await fetchWithStatus(`${origin}/robots.txt`, { timeoutMs: 8000, userAgent: USER_AGENT })
  const robotsTxt = result.fetch_status === 'ok' ? result.body : ''
  return path => isPathDisallowedByRobots(robotsTxt, path, USER_AGENT)
}

async function crawlJournal(journal, { concurrency, delayMs, publisherRegistry }) {
  const posiId = journal.posi_id
  const websiteUrl = journal.website_url

  if (!websiteUrl) {
    // Full-shape output (all 21 criteria present, status 'unknown' except
    // other_applicable_terms which is always 'not_applicable') instead of
    // an empty evidence_items array -- review-caught gap: downstream
    // consumers (AJR-E scoring, coverage aggregation) expect a consistent
    // per-journal shape regardless of whether a crawl was even possible.
    const evidenceItems = resolveAllCriteria([], null)
    const coverage = evidenceCoverage(evidenceItems)
    return {
      posi_id: posiId, journal_code: journal.journal_code, title: journal.title,
      website_url: null, fetched_pages: [], evidence_items: evidenceItems,
      coverage, site_evidence_coverage_percent: coverage.coverage_percent,
      evidence_methodology_version: EVIDENCE_COVERAGE_METHODOLOGY_VERSION,
      snapshot_date: new Date().toISOString().slice(0, 10),
      note: 'no website_url on record -- nothing to crawl',
    }
  }

  let origin
  try {
    origin = new URL(websiteUrl).origin
  } catch {
    // Malformed website_url -- isolate to this journal, never throw and
    // abort the whole batch. Review-caught gap: `new URL()` here was
    // unguarded, and main()'s loop had no try/catch around crawlJournal(),
    // so one bad URL among 1000 journals would have crashed the entire run.
    const evidenceItems = resolveAllCriteria([], null)
    const coverage = evidenceCoverage(evidenceItems)
    return {
      posi_id: posiId, journal_code: journal.journal_code, title: journal.title,
      website_url: websiteUrl, fetched_pages: [], evidence_items: evidenceItems,
      coverage, site_evidence_coverage_percent: coverage.coverage_percent,
      evidence_methodology_version: EVIDENCE_COVERAGE_METHODOLOGY_VERSION,
      snapshot_date: new Date().toISOString().slice(0, 10),
      note: `malformed website_url, could not parse: ${websiteUrl}`,
    }
  }
  const isDisallowed = await fetchRobotsDisallowChecker(websiteUrl)

  const candidates = candidateUrls(websiteUrl)
  const toFetch = []
  const robotsBlockedUrls = []
  for (const url of candidates) {
    const path = url.replace(origin, '') || '/'
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
  // Discovered links go through the SAME robots.txt check as the fixed
  // candidate paths -- an earlier version of this script only checked
  // CANDIDATE_PATHS, letting link-discovered URLs silently bypass the
  // robots rules already established for this site (review-caught bug).
  const seedPages = fetchedPages.filter(p => p.fetch_status === 'ok' && p.body)
  const discoveredLinks = new Set()
  for (const page of seedPages.slice(0, 3)) {
    // Resolve relative hrefs against the page THEY WERE FOUND ON
    // (page.url), not the journal's homepage -- review-caught bug: an
    // href="ethics" found on /about must resolve to /about/ethics, not to
    // a root-relative /ethics, which is what passing websiteUrl here
    // produced.
    for (const link of discoverLinks(page.body, page.url)) discoveredLinks.add(link)
  }
  const alreadyFetched = new Set(fetchedPages.map(p => p.url))
  const candidateNewLinks = [...discoveredLinks].filter(u => !alreadyFetched.has(u)).slice(0, Math.max(0, MAX_PAGES_PER_JOURNAL - fetchedPages.length))
  const newLinksToFetch = []
  for (const url of candidateNewLinks) {
    const path = url.replace(origin, '') || '/'
    if (isDisallowed(path)) fetchedPages.push({ url, fetch_status: 'robots_blocked', http_status: null, body: null, retrieved_at: new Date().toISOString(), error: null })
    else newLinksToFetch.push(url)
  }
  if (newLinksToFetch.length > 0) {
    const discoveredResults = await runBatch(
      newLinksToFetch,
      url => fetchWithStatus(url, { timeoutMs: 10000, userAgent: USER_AGENT }),
      concurrency, delayMs
    )
    fetchedPages = fetchedPages.concat(discoveredResults)
  }

  let evidenceItems = resolveAllCriteria(fetchedPages, websiteUrl)
  evidenceItems = applyPublisherInheritance(evidenceItems, journal.publisher, publisherRegistry)

  const coverage = evidenceCoverage(evidenceItems)

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
    site_evidence_coverage_percent: coverage.coverage_percent,
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

  // Review-caught gap: an unvalidated concurrency (0, NaN, negative) makes
  // runBatch()'s `for (let i = 0; i < items.length; i += concurrency)`
  // loop either infinite (i never advances) or never execute -- fail loud
  // and immediately instead of hanging or silently processing nothing.
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer, got: ${arg('concurrency', '4')}`)
    process.exit(1)
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    console.error(`--delay-ms must be a non-negative integer, got: ${arg('delay-ms', '500')}`)
    process.exit(1)
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const journalsOutDir = join(outDir, 'journals')
  if (!existsSync(journalsOutDir)) mkdirSync(journalsOutDir, { recursive: true })

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'))
  const targets = limit ? corpus.slice(0, limit) : corpus
  console.log(`Loaded ${corpus.length} journals from ${corpusPath}${limit ? ` (processing first ${targets.length})` : ''}`)

  const publisherRegistry = loadPublisherRegistry(publisherRegistryDir)
  console.log(`Publisher registry: ${publisherRegistry.length} entries loaded`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i]
    process.stdout.write(`[${i + 1}/${targets.length}] ${j.title} (${j.posi_id ?? 'NO POSI_ID'}) ... `)
    let result
    try {
      result = await crawlJournal(j, { concurrency, delayMs, publisherRegistry })
    } catch (err) {
      // Defense in depth beyond crawlJournal()'s own malformed-URL guard --
      // one journal's unexpected failure must never abort a 1000-journal
      // batch run and lose all prior progress.
      console.log(`ERROR (isolated to this journal): ${err?.message ?? err}`)
      const evidenceItems = resolveAllCriteria([], null)
      const coverage = evidenceCoverage(evidenceItems)
      result = {
        posi_id: j.posi_id, journal_code: j.journal_code, title: j.title,
        website_url: j.website_url ?? null, fetched_pages: [], evidence_items: evidenceItems,
        coverage, site_evidence_coverage_percent: coverage.coverage_percent,
        evidence_methodology_version: EVIDENCE_COVERAGE_METHODOLOGY_VERSION,
        snapshot_date: new Date().toISOString().slice(0, 10),
        note: `unexpected error during crawl, isolated: ${err?.message ?? err}`,
      }
    }
    results.push(result)
    writeFileSync(join(journalsOutDir, `${result.posi_id ?? j.journal_code}.json`), JSON.stringify(result, null, 2), 'utf-8')
    console.log(`site evidence coverage ${result.site_evidence_coverage_percent}% (${result.fetched_pages.length} pages fetched)`)
  }

  // --- Coverage distribution + error-mode summary ---
  const distribution = { '100%': 0, '90-99%': 0, '80-89%': 0, '60-79%': 0, '<60%': 0 }
  let blockedCount = 0, notFoundFetchCount = 0, conflictedCount = 0, staleCount = 0, unknownCount = 0, metCount = 0, notMetCount = 0, notApplicableCount = 0
  for (const r of results) {
    distribution[bucketCoverage(r.site_evidence_coverage_percent)]++
    for (const item of r.evidence_items) {
      if (item.status === 'blocked') blockedCount++
      if (item.status === 'unknown') unknownCount++
      if (item.status === 'conflicted') conflictedCount++
      if (item.status === 'stale') staleCount++
      if (item.status === 'met') metCount++
      if (item.status === 'not_met') notMetCount++
      if (item.status === 'not_applicable') notApplicableCount++
    }
    for (const p of r.fetched_pages) {
      if (p.fetch_status === 'not_found') notFoundFetchCount++
    }
  }

  const summary = {
    input_journals: targets.length,
    journals_with_website_url: results.filter(r => r.website_url).length,
    journals_with_no_website_url: results.filter(r => !r.website_url).length,
    total_pages_fetched: results.reduce((s, r) => s + r.fetched_pages.length, 0),
    total_pages_ok: results.reduce((s, r) => s + r.fetched_pages.filter(p => p.fetch_status === 'ok').length, 0),
    site_evidence_coverage_distribution: distribution,
    evidence_item_status_counts: {
      met: metCount, not_met: notMetCount, blocked: blockedCount, unknown: unknownCount, conflicted: conflictedCount, stale: staleCount, not_applicable: notApplicableCount,
    },
    fetch_404_count: notFoundFetchCount,
    mean_site_evidence_coverage_percent: Math.round((results.reduce((s, r) => s + r.site_evidence_coverage_percent, 0) / results.length) * 100) / 100,
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'per-journal-coverage.csv'),
    ['posi_id,title,site_evidence_coverage_percent,pages_fetched,pages_ok']
      .concat(results.map(r => `${r.posi_id},"${(r.title ?? '').replace(/"/g, '""')}",${r.site_evidence_coverage_percent},${r.fetched_pages.length},${r.fetched_pages.filter(p => p.fetch_status === 'ok').length}`))
      .join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
