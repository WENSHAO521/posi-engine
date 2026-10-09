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
 * After the crawl, items the site left unknown or blocked are resolved,
 * in this order (AJR-SPEC.md § 8, EC-1.1): from a verified publisher
 * registry entry, then from the journal's own Crossref deposits
 * (src/crossref-policy-signals.mjs). --no-crossref skips the second step
 * (the evidence trial uses it to compare with and without).
 *
 * Usage:
 *   node scripts/run-evidence-etl.mjs \
 *     --corpus <path to corpus/core-collection.json> \
 *     --publisher-registry <path to evidence/publishers dir, optional> \
 *     --out <output dir> \
 *     [--limit N] [--concurrency 4] [--delay-ms 500] [--no-crossref]
 *     [--rating-date YYYY-MM-DD]   (the Crossref sample ends on this date; default today)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { fetchWithStatus, isPathDisallowedByRobots, evidenceSnapshotStatus } from '../src/evidence-fetch.mjs'
import { candidateUrls, discoverLinks, discoveryBaseUrl, selectNewLinks } from '../src/evidence-page-discovery.mjs'
import { resolveAllCriteria, EVIDENCE_CRITERIA } from '../src/evidence-resolver.mjs'
import { applyPublisherInheritance } from '../src/evidence-publisher-registry.mjs'
import { journalItemShares, applyCrossrefSignals } from '../src/crossref-policy-signals.mjs'
import { fetchCrossrefPolicySample } from '../src/crossref-policy-fetch.mjs'
import { evidenceCoverage, dimensionScore, EVIDENCE_COVERAGE_METHODOLOGY_VERSION } from '../src/evidence-coverage.mjs'

const USER_AGENT = 'POSI-EvidenceETL/1.0 (+https://posi.panorama-sg.com; posi@panorama-sg.com)'
// Budget for pages found by link discovery. It used to be 30 minus every
// fixed candidate path already tried, and most of those are 404s on a given
// site, so a site with ~27 guessed paths left room for 3 discovered links
// (AI Med's Policies pages were cut off that way). Discovery now has its own
// budget.
const MAX_DISCOVERED_PAGES = 30
// Further budget for links found on those discovered pages (policy hubs).
const MAX_SECOND_LEVEL_PAGES = 20

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

/**
 * Resolves what the site left unknown/blocked: publisher registry first,
 * then the journal's Crossref deposits (EC-1.1). Returns the items and a record of the
 * Crossref step.
 */
async function resolveGaps(items, journal, { publisherRegistry, crossref, ratingDate }) {
  let out = applyPublisherInheritance(items, journal.publisher, publisherRegistry)
  if (!crossref) return { items: out, crossref: null }
  const sample = await fetchCrossrefPolicySample(journal, { now: ratingDate })
  const shares = journalItemShares(sample.works)
  const applied = applyCrossrefSignals(out, shares, { sourceUrl: sample.sourceUrl, retrievedAt: new Date().toISOString(), sampleUntil: sample.until })
  return {
    items: applied.items,
    crossref: { articles: sample.works.length, since: sample.since, until: sample.until, failed: sample.failed, attempts: sample.attempts, item_shares: shares, upgraded: applied.upgraded },
  }
}

async function crawlJournal(journal, { concurrency, delayMs, publisherRegistry, crossref, ratingDate }) {
  const posiId = journal.posi_id
  const websiteUrl = journal.website_url

  if (!websiteUrl) {
    // Full-shape output (all 21 criteria present, status 'unknown' except
    // other_applicable_terms which is always 'not_applicable') instead of
    // an empty evidence_items array -- review-caught gap: downstream
    // consumers (AJR-E scoring, coverage aggregation) expect a consistent
    // per-journal shape regardless of whether a crawl was even possible.
    const gaps = await resolveGaps(resolveAllCriteria([], null), journal, { publisherRegistry, crossref, ratingDate })
    const evidenceItems = gaps.items
    const coverage = evidenceCoverage(evidenceItems)
    return {
      posi_id: posiId, journal_code: journal.journal_code, title: journal.title,
      website_url: null, fetched_pages: [], evidence_items: evidenceItems, crossref_evidence: gaps.crossref,
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
    const gaps = await resolveGaps(resolveAllCriteria([], null), journal, { publisherRegistry, crossref, ratingDate })
    const evidenceItems = gaps.items
    const coverage = evidenceCoverage(evidenceItems)
    return {
      posi_id: posiId, journal_code: journal.journal_code, title: journal.title,
      website_url: websiteUrl, fetched_pages: [], evidence_items: evidenceItems, crossref_evidence: gaps.crossref,
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

  const fetchPage = url => fetchWithStatus(url, { timeoutMs: 10000, userAgent: USER_AGENT })

  let fetchedPages = await runBatch(toFetch, fetchPage, concurrency, delayMs)
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
  // The journal code is in every URL of its own site and must not count as a keyword hit.
  const ignoreTokens = [journal.journal_code]
  const discoveredLinks = new Set()
  for (const page of seedPages.slice(0, 3)) {
    // Resolve relative hrefs against the page THEY WERE FOUND ON
    // (page.url), not the journal's homepage -- review-caught bug: an
    // href="ethics" found on /about must resolve to /about/ethics, not to
    // a root-relative /ethics, which is what passing websiteUrl here
    // produced.
    for (const link of discoverLinks(page.body, discoveryBaseUrl(page), { ignoreTokens })) discoveredLinks.add(link)
  }
  const alreadyFetched = new Set(fetchedPages.map(p => p.url))

  // Fetches up to `budget` not-yet-fetched links, with the same robots.txt
  // check as the fixed candidate paths.
  const fetchDiscovered = async (links, budget) => {
    const fresh = selectNewLinks(links, alreadyFetched, budget)
    const toGet = []
    for (const url of fresh) {
      alreadyFetched.add(url)
      const path = url.replace(origin, '') || '/'
      if (isDisallowed(path)) fetchedPages.push({ url, fetch_status: 'robots_blocked', http_status: null, body: null, retrieved_at: new Date().toISOString(), error: null })
      else toGet.push(url)
    }
    if (toGet.length === 0) return []
    const results = await runBatch(toGet, fetchPage, concurrency, delayMs)
    fetchedPages = fetchedPages.concat(results)
    return results
  }

  await fetchDiscovered(discoveredLinks, MAX_DISCOVERED_PAGES)

  // One level further: a policies hub linked from the homepage lists the
  // individual policy pages (AI use, ethics, misconduct ...), which the
  // homepage itself does not link to. Links are taken from every page read so
  // far, including a hub that is also a fixed candidate path (already fetched,
  // so not among the newly discovered pages), with their own budget.
  const secondLevel = new Set()
  for (const page of fetchedPages.filter(p => p.fetch_status === 'ok' && p.body)) {
    for (const link of discoverLinks(page.body, discoveryBaseUrl(page), { ignoreTokens })) secondLevel.add(link)
  }
  if (secondLevel.size > 0) await fetchDiscovered(secondLevel, MAX_SECOND_LEVEL_PAGES)

  const gaps = await resolveGaps(resolveAllCriteria(fetchedPages, websiteUrl), journal, { publisherRegistry, crossref, ratingDate })
  const evidenceItems = gaps.items

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
    crossref_evidence: gaps.crossref,
    dimension_scores: dimensionScores,
    coverage,
    site_evidence_coverage_percent: coverage.coverage_percent,
    evidence_methodology_version: EVIDENCE_COVERAGE_METHODOLOGY_VERSION,
    snapshot_date: new Date().toISOString().slice(0, 10),
    ...evidenceSnapshotStatus(fetchedPages),
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
  const crossref = !process.argv.includes('--no-crossref')
  const ratingDate = arg('rating-date') ? new Date(`${arg('rating-date')}T00:00:00Z`) : new Date()
  if (Number.isNaN(ratingDate.getTime())) {
    console.error(`--rating-date must be YYYY-MM-DD, got: ${arg('rating-date')}`)
    process.exit(1)
  }

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
      result = await crawlJournal(j, { concurrency, delayMs, publisherRegistry, crossref, ratingDate })
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
        // The crawl itself failed: nothing says the source is unusable, so
        // the snapshot asks for a recrawl.
        evidence_snapshot_status: 'partial_source_unavailable', recrawl_required: true,
        recrawl_reason: 'crawl_error', recrawl_host: null,
      }
    }
    // A journal with no (usable) website_url was not crawled at all: no
    // flaky source to retry, so its snapshot is complete as it stands.
    if (!result.evidence_snapshot_status) Object.assign(result, evidenceSnapshotStatus(result.fetched_pages))
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
