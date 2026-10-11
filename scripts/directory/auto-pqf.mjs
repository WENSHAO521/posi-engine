#!/usr/bin/env node
/**
 * auto-pqf.mjs
 *
 * Computes automated PQF scores for all of DISCOVERED_JOURNALS. DOAJ listing is
 * NOT an eligibility gate — every discovered journal is scored regardless of
 * doaj_status, since DOAJ is external reference metadata, not a POSI admission
 * signal. Scoring itself is POSI's own standard, not DOAJ's: every subfactor is
 * computed primarily
 * from POSI's own direct verification, not from trusting a third party's
 * self-reported bibjson:
 *   - JTF/EGF/RIF: crawled directly from the journal's own website for the same
 *     evidence categories published in /pqf (aim & scope, peer review, editorial
 *     board, APC/waiver, license, ethics, corrections, plagiarism policy, etc.)
 *   - MQF: sampled directly from a Crossref work record (abstract, license,
 *     references, ORCID presence) plus ISSN/article-count completeness.
 *   - TDF: direct sitemap.xml/robots.txt probes and a live DOI-resolution check.
 *   - CVF: live OpenAlex source match + OpenCitations sample check.
 * Fallback: many journal platforms (MDPI among them) block simple server-side
 * fetches with bot protection, so a direct website crawl fails outright for a
 * meaningful share of journals. Rather than silently scoring those journals 0
 * on JTF/EGF/RIF (indistinguishable from "verified absent"), if the direct
 * crawl fails, POSI falls back to DOAJ's public bibjson as a disclosed
 * secondary signal — see fetchDoajFallback() below. This is intentionally a
 * lower-confidence path (several RIF/EGF items DOAJ bibjson doesn't cover are
 * left unscored rather than guessed) and is used only when direct verification
 * isn't possible, never as the primary source.
 * This is slower per journal than a DOAJ-only version (more live fetches per
 * journal), so scoring is incremental: each run takes the journals with no
 * automated score first, then those whose score is oldest (auto_pqf.evaluated_at),
 * and stops starting new ones when its time budget runs out. Everything
 * scored so far is written. Run daily, this refreshes every score in a rolling
 * cycle and scores new discoveries the day they arrive, instead of trying to
 * re-crawl all ~24,000 sites in one run (which never finished within the CI
 * time limit, so nothing was saved).
 *
 * Usage:
 *   node scripts/auto-pqf.mjs                          # dry run — print scores
 *   node scripts/auto-pqf.mjs --write                  # write auto_pqf to discovered-journals.json
 *   node scripts/auto-pqf.mjs --limit 50               # at most N journals
 *   node scripts/auto-pqf.mjs --write --budget-minutes 20   # stop starting new journals after 20 minutes
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

import { loadDiscovered, saveDiscovered, autoPqf } from './lib/discovered-store.mjs'
const WRITE = process.argv.includes('--write')
const UA = 'POSI/0.1 (mailto:posi@panoramagroup.org)'
const CONCURRENCY = 5
const DELAY_MS = 300
const limitIdx = process.argv.indexOf('--limit')
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : null
const budgetIdx = process.argv.indexOf('--budget-minutes')
const DEADLINE = budgetIdx !== -1 ? Date.now() + parseFloat(process.argv[budgetIdx + 1]) * 60_000 : Infinity
const TODAY = new Date().toISOString().slice(0, 10)

// ─── Website crawl — POSI's own direct verification, replacing DOAJ bibjson ──

async function fetchText(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function hasAny(text, patterns) {
  if (!text) return false
  const lower = text.toLowerCase()
  return patterns.some(p => lower.includes(p))
}

async function crawlJournalSite(websiteUrl) {
  if (!websiteUrl) return null
  const home = await fetchText(websiteUrl)
  if (!home) return null
  return {
    aimScope: hasAny(home, ['aim and scope', 'aims and scope', 'about the journal', 'journal focus', 'focus and scope']),
    peerReview: hasAny(home, ['peer review', 'peer-review', 'peer reviewed', 'double-blind', 'single-blind', 'double blind review']),
    editorialBoard: hasAny(home, ['editorial board', 'editorial team', 'board of editors']),
    apc: hasAny(home, ['article processing charge', 'apc', 'publication fee', 'processing fee']),
    waiver: hasAny(home, ['waiver', 'fee waiver', 'fee discount', 'no charge']),
    openAccess: hasAny(home, ['open access']),
    license: hasAny(home, ['creative commons', 'cc by', 'copyright notice']),
    ethics: hasAny(home, ['publication ethics', 'committee on publication ethics', 'cope guidelines']),
    corrections: hasAny(home, ['retraction', 'correction policy', 'errata']),
    plagiarism: hasAny(home, ['plagiarism', 'similarity check', 'turnitin', 'ithenticate', 'similarity index']),
    dataAvailability: hasAny(home, ['data availability', 'data sharing', 'data accessibility']),
    authorshipCriteria: hasAny(home, ['authorship criteria', 'icmje', 'author contribution']),
  }
}

// Disclosed fallback for JTF/EGF/RIF when a direct website crawl fails (bot
// protection, timeout, dead link, etc.) — see file header. Maps DOAJ's public
// bibjson onto the same shape crawlJournalSite() returns so it flows through
// the same scoring functions, but leaves fields DOAJ doesn't cover (ethics
// detail, corrections, plagiarism, data availability, authorship criteria)
// as false rather than guessing — a weaker, lower-confidence signal by design.
async function fetchDoajFallback(issn) {
  if (!issn) return null
  try {
    const res = await fetch(`https://doaj.org/api/search/journals/issn:${issn}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const first = data.results?.[0]
    if (!first) return null
    const bib = first.bibjson ?? {}
    const reviewProcesses = bib.editorial?.review_processes ?? []
    const license = (bib.license?.[0]?.type ?? '')
    return {
      aimScope: true,   // DOAJ listing requires a stated aim & scope during application
      peerReview: reviewProcesses.some(r => String(r).toLowerCase().includes('peer')),
      editorialBoard: !!bib.editorial?.board_url,
      apc: !!bib.apc?.has_apc,
      waiver: !bib.apc?.has_apc || (bib.apc?.max?.length ?? 0) > 0,
      openAccess: true, // DOAJ only lists open-access journals
      license: license.length > 0,
      ethics: false,
      corrections: false,
      plagiarism: false,
      dataAvailability: false,
      authorshipCriteria: false,
    }
  } catch {
    return null
  }
}

async function checkSitemap(websiteUrl) {
  if (!websiteUrl) return false
  const base = websiteUrl.replace(/\/+$/, '')
  const xml = await fetchText(`${base}/sitemap.xml`, 8000)
  return !!xml && (xml.includes('<urlset') || xml.includes('<sitemapindex'))
}

async function checkRobots(websiteUrl) {
  if (!websiteUrl) return false
  const base = websiteUrl.replace(/\/+$/, '')
  const txt = await fetchText(`${base}/robots.txt`, 8000)
  if (txt == null) return false
  // Crude "not blocking everything" check rather than a full robots.txt parse.
  return !/^\s*disallow:\s*\/\s*$/im.test(txt)
}

async function checkDoiResolves(doi) {
  if (!doi) return false
  try {
    const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ─── Crossref (article-inventory + metadata-completeness signals) ───────────

// One sample DOI per journal is enough to check completeness/resolution — not
// a per-article scoring pass.
async function fetchSampleDoi(issn) {
  try {
    const res = await fetch(`https://api.crossref.org/journals/${issn}/works?rows=1&select=DOI&mailto=posi@panoramagroup.org`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.message?.items?.[0]?.DOI ?? null
  } catch {
    return null
  }
}

async function fetchCrossrefWorkSample(doi) {
  if (!doi) return null
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const w = data.message ?? {}
    return {
      hasAbstract: !!w.abstract,
      hasLicense: Array.isArray(w.license) && w.license.length > 0,
      hasReferences: (w['reference-count'] ?? 0) > 0,
      hasOrcid: (w.author ?? []).some(a => !!a.ORCID),
    }
  } catch {
    return null
  }
}

// ─── OpenAlex / OpenCitations (live citation-infrastructure checks) ─────────

async function fetchOpenAlexStats(issn) {
  try {
    const params = new URLSearchParams({
      filter: `issn:${issn}`,
      select: 'summary_stats,cited_by_count',
      mailto: 'posi@panoramagroup.org',
    })
    const res = await fetch(`https://api.openalex.org/sources?${params.toString()}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const source = data.results?.[0]
    if (!source) return null
    return {
      two_yr_mean_citedness: source.summary_stats?.['2yr_mean_citedness'] ?? null,
      h_index: source.summary_stats?.h_index ?? null,
      cited_by_count: source.cited_by_count ?? null,
    }
  } catch {
    return null
  }
}

async function fetchOpenCitationsSample(doi) {
  if (!doi) return null
  try {
    const res = await fetch(`https://api.opencitations.net/index/v1/citation-count/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const count = data?.[0]?.count
    return count != null ? parseInt(count, 10) : null
  } catch {
    return null
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function grade(total) {
  if (total >= 90) return 'A+'
  if (total >= 80) return 'A'
  if (total >= 70) return 'B+'
  if (total >= 60) return 'B'
  if (total >= 50) return 'C'
  if (total >= 40) return 'D'
  return 'E'
}

function clamp(v, max) { return Math.max(0, Math.min(v, max)) }

function scoreJtf(site) {
  // JTF — Journal Transparency Factor /25 — same evidence categories as manual PQF's JTF
  if (!site) return 0
  let s = 0
  if (site.aimScope) s += 3
  if (site.peerReview) s += 4
  if (site.editorialBoard) s += 3
  if (site.apc) s += 3
  if (site.waiver) s += 2
  if (site.openAccess) s += 3
  if (site.license) s += 3
  if (site.ethics) s += 2
  if (site.corrections) s += 2
  return clamp(s, 25)
}

function scoreMqf(journal, crSample) {
  // MQF — Metadata Quality Factor /25
  let s = 0
  if ((journal.article_count ?? 0) > 0) s += 8         // at least some DOI-registered articles
  if (journal.issn_print && journal.issn_online) s += 3
  else if (journal.issn_print || journal.issn_online) s += 1
  if (crSample) {
    if (crSample.hasAbstract) s += 4
    if (crSample.hasLicense) s += 4
    if (crSample.hasReferences) s += 3
    if (crSample.hasOrcid) s += 3
  }
  return clamp(s, 25)
}

function scoreEgf(site) {
  // EGF — Editorial Governance Factor /20
  // POSI's automated crawl can only directly verify presence of these pages,
  // not deeper items like board geographic diversity — those require manual
  // review and are reserved for Official PQF.
  if (!site) return 0
  let s = 0
  if (site.editorialBoard) s += 8
  if (site.peerReview) s += 6
  if (site.aimScope) s += 4
  if (site.ethics) s += 2
  return clamp(s, 20)
}

function scoreTdf(sitemapOk, robotsOk, openAlexStats, doiResolves) {
  // TDF — Technical Discoverability /15
  let s = 0
  if (sitemapOk) s += 4
  if (robotsOk) s += 3
  if (openAlexStats) s += 4   // broad third-party indexing/discoverability proxy
  if (doiResolves) s += 4
  return clamp(s, 15)
}

function scoreCvf(openAlexStats, openCitationsCount, journal) {
  // CVF — Citation Visibility Factor /10 — live checks, unchanged in spirit from
  // the prior version (already didn't score raw citation volume, see /cvi).
  let s = 0
  if (openAlexStats) s += 4
  else if (journal.openalex_source_id) s += 1
  if (openCitationsCount != null) s += 4
  if ((journal.article_count ?? 0) > 0) s += 2
  return clamp(s, 10)
}

function scoreRif(site) {
  // RIF — Research Integrity Factor /5
  if (!site) return 0
  let s = 0
  if (site.corrections) s += 1
  if (site.plagiarism) s += 1
  if (site.dataAvailability) s += 1
  if (site.ethics) s += 1
  if (site.authorshipCriteria) s += 1
  return clamp(s, 5)
}

function computeAutoPqf({ site, journal, crSample, sitemapOk, robotsOk, doiResolves, openAlexStats, openCitationsCount }) {
  const jtf = scoreJtf(site)
  const mqf = scoreMqf(journal, crSample)
  const egf = scoreEgf(site)
  const tdf = scoreTdf(sitemapOk, robotsOk, openAlexStats, doiResolves)
  const cvf = scoreCvf(openAlexStats, openCitationsCount, journal)
  const rif = scoreRif(site)
  const total = jtf + mqf + egf + tdf + cvf + rif
  return { jtf, mqf, egf, tdf, cvf, rif, total, grade: grade(total) }
}

// ─── Parse all discovered journals ─────────────────────────────────────────
// No DOAJ-based eligibility filter — every discovered journal is scored, and
// no DOAJ field is read into the scoring functions above.

// Unscored journals first, then the oldest scores; the file's order breaks ties.
function parseDiscoveredListed(records) {
  const age = r => r.auto_pqf?.evaluated_at ?? ''
  return records.map((r, i) => ({ r, i })).sort((a, b) => age(a.r).localeCompare(age(b.r)) || a.i - b.i).map(({ r }) => ({
    id: r.id,
    code: r.journal_code,
    issnOnline: r.issn_online ?? null,
    issnPrint: r.issn_print ?? null,
    openalex_source_id: r.openalex_source_id ?? null,
    article_count: r.article_count ?? 0,
    website_url: r.website_url || null,
  }))
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runBatch(items, fn, concurrency) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    if (Date.now() >= DEADLINE) {
      console.log(`\nTime budget reached after ${i} of ${items.length} journals; the rest follow in later runs.`)
      break
    }
    const batch = items.slice(i, i + concurrency)
    const br = await Promise.all(batch.map(fn))
    results.push(...br)
    if (i + concurrency < items.length) await sleep(DELAY_MS)
  }
  return results
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const records = loadDiscovered()
  const byId = new Map(records.map(r => [r.id, r]))
  const allListed = parseDiscoveredListed(records)
  const listed = LIMIT ? allListed.slice(0, LIMIT) : allListed
  const unscored = records.filter(r => !r.auto_pqf).length
  console.log(`Found ${allListed.length} DISCOVERED_JOURNALS, ${unscored} not yet scored (scoring prioritizes direct verification; DOAJ used only as a disclosed fallback when a site can't be crawled, never as an eligibility filter)${LIMIT ? ` — processing at most ${listed.length}` : ''}${DEADLINE < Infinity ? `, within a ${process.argv[budgetIdx + 1]}-minute budget` : ''}. Unscored first, then oldest scores.\n`)

  const results = await runBatch(listed, async (j) => {
    const issn = j.issnOnline ?? j.issnPrint
    const [siteFromCrawl, sitemapOk, robotsOk, sampleDoi, openAlexStats] = await Promise.all([
      crawlJournalSite(j.website_url),
      checkSitemap(j.website_url),
      checkRobots(j.website_url),
      issn ? fetchSampleDoi(issn) : null,
      issn ? fetchOpenAlexStats(issn) : null,
    ])
    const [crSample, doiResolves, openCitationsCount] = await Promise.all([
      fetchCrossrefWorkSample(sampleDoi),
      checkDoiResolves(sampleDoi),
      fetchOpenCitationsSample(sampleDoi),
    ])
    // Direct crawl failed (bot-blocked site, dead link, no website_url at all) —
    // fall back to DOAJ's public bibjson as a disclosed, lower-confidence signal.
    let site = siteFromCrawl
    let usedDoajFallback = false
    if (!site) {
      site = await fetchDoajFallback(issn)
      usedDoajFallback = !!site
    }
    process.stdout.write(usedDoajFallback ? 'd' : '.')
    return { ...j, site, usedDoajFallback, sitemapOk, robotsOk, crSample, doiResolves, openAlexStats, openCitationsCount }
  }, CONCURRENCY)
  console.log('\n')

  let scored = 0
  let skipped = 0
  let fallbackCount = 0

  for (const { id, code, website_url, usedDoajFallback, ...rest } of results) {
    if (!rest.site) { skipped++; continue }  // no direct evidence and no DOAJ fallback available
    if (usedDoajFallback) fallbackCount++
    const journal = { article_count: rest.article_count, issn_online: rest.issnOnline, issn_print: rest.issnPrint, openalex_source_id: rest.openalex_source_id }
    const scores = computeAutoPqf({ ...rest, journal })
    scored++

    if (!WRITE) {
      console.log(`[${code}] JTF:${scores.jtf} MQF:${scores.mqf} EGF:${scores.egf} TDF:${scores.tdf} CVF:${scores.cvf} RIF:${scores.rif} → ${scores.total} ${scores.grade}${usedDoajFallback ? ' (DOAJ fallback)' : ''}`)
    } else {
      const rec = byId.get(id)
      if (rec) rec.auto_pqf = autoPqf(scores, TODAY)
    }
  }

  console.log(`\nScored: ${scored} (${fallbackCount} via DOAJ fallback)  Skipped (no evidence available): ${skipped}`)

  if (WRITE) {
    saveDiscovered(records)
    console.log(`Written auto_pqf for ${scored} journals to discovered-journals.json`)
  } else {
    console.log('\nDry run. Pass --write to update discovered-journals.json.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
