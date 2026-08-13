#!/usr/bin/env node
/**
 * run-works-etl.mjs — Article-Sample ETL v1 orchestrator. Ties together
 * works-fetch.mjs / works-resolver.mjs into a real per-journal run against
 * a corpus file (posi-data's corpus/core-collection.json), producing the
 * article-level data ajr-early-stage.mjs's Dimensions 3-6 need and that no
 * pipeline in this repo produced before now — the Evidence ETL v1 pipeline
 * (run-evidence-etl.mjs) only ever crawled journal WEBSITES for Dimensions
 * 1/2/7's policy-disclosure items.
 *
 * For each journal with a usable ISSN:
 *   1. Page through Crossref's /journals/{issn}/works (works-fetch.mjs),
 *      most-recent-first, up to MAX_WORKS_FETCHED_PER_JOURNAL.
 *   2. Normalize every fetched work (works-resolver.mjs#normalizeCrossrefWork)
 *      and select a spread-across-issues sample up to TARGET_ARTICLE_SAMPLE_SIZE
 *      (ajr-early-stage.mjs) -- this IS the `articles` input Dimensions 5/6 need.
 *   3. Spot-check DOI resolution on the sample (live doi.org requests) and,
 *      if the journal has an `oai_base_url` on its corpus record, check that
 *      endpoint live -- both feed Dimension 3's evidence items.
 *   4. Compute cadence/continuity window stats from EVERY fetched work's
 *      publication date (not just the ~30-article sample) against the
 *      journal's own stated `frequency` and its already-resolved
 *      `early_stage_rating.first_published` (FPD-1.0, first-publication-
 *      date.mjs) -- reused, not re-derived, per this project's existing
 *      lifecycle-resolution work.
 *
 * Does NOT call ajr-early-stage.mjs's computeAjrE() and does NOT touch
 * corpus/core-collection.json -- this script's output is article-sample
 * evidence only, the same separation-of-concerns run-evidence-etl.mjs
 * already established for site evidence. Computing a real AJR-E-1.1 score
 * is a later step, once this data exists alongside the existing site
 * evidence (evidence/journals/) for a journal.
 *
 * `frequency_disclosed` (Dimension 4) is NOT resolved anywhere in this
 * script -- see works-resolver.mjs's header for why (a website-crawl
 * question, not an article-data question; stays `unknown` here, a known,
 * separate, small gap for a future addition to evidence-resolver.mjs).
 *
 * Usage:
 *   node scripts/run-works-etl.mjs \
 *     --corpus <path to corpus/core-collection.json> \
 *     --out <output dir> \
 *     [--limit N] [--concurrency 3] [--delay-ms 500] [--doi-checks 10]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { fetchAllCrossrefWorks, checkDoiResolution, checkOaiPmhEndpoint } from '../src/works-fetch.mjs'
import {
  normalizeCrossrefWork, selectArticleSample, deriveInfrastructureItemStatuses,
  computePublicationWindowStats, deriveDepositTimeliness, WORKS_RESOLVER_METHODOLOGY_VERSION,
} from '../src/works-resolver.mjs'
import { assessArticleSampleAdequacy, TARGET_ARTICLE_SAMPLE_SIZE } from '../src/ajr-early-stage.mjs'

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

/** A journal's own ISSN — prefers issn_online, falls back to issn_print;
 * Crossref's /journals/{issn} route accepts either. Returns null (never a
 * guess) when neither exists on record. */
function journalIssn(journal) {
  return journal.issn_online ?? journal.issn_print ?? null
}

function emptyResult(journal, note) {
  return {
    posi_id: journal.posi_id, journal_code: journal.journal_code, title: journal.title,
    issn_queried: null, crossref_status: null, total_results: null, works_fetched: 0,
    article_sample: [], sample_adequacy: assessArticleSampleAdequacy([]),
    infrastructure_item_statuses: deriveInfrastructureItemStatuses({ sample: [], doiChecks: [], oaiPmhCheck: null }),
    doi_resolution_checks: [], oai_pmh_check: null,
    publishing_stability: { cadence: { expectedWindows: 0, metWindows: 0 }, continuity: { totalWindows: 0, activeWindows: 0 }, deposit_timeliness: 'unknown' },
    frequency_disclosed: 'unknown',
    first_publication_date_used: null,
    works_methodology_version: WORKS_RESOLVER_METHODOLOGY_VERSION,
    snapshot_date: new Date().toISOString().slice(0, 10),
    note,
  }
}

async function processJournal(journal, { concurrency, delayMs, doiCheckCount, ratingDate }) {
  const issn = journalIssn(journal)
  if (!issn) return emptyResult(journal, 'no issn_online or issn_print on record -- nothing to query Crossref with')

  const fetchResult = await fetchAllCrossrefWorks(issn, { concurrency, delayMs })
  if (fetchResult.status !== 200) {
    return {
      ...emptyResult(journal, fetchResult.status === 404
        ? 'Crossref has no works registered under this ISSN'
        : `Crossref fetch did not succeed: status=${fetchResult.status} error=${fetchResult.error}`),
      issn_queried: issn, crossref_status: fetchResult.status,
    }
  }

  const allArticles = fetchResult.items.map(normalizeCrossrefWork)
  const sample = selectArticleSample(allArticles, { target: TARGET_ARTICLE_SAMPLE_SIZE })
  const sampleAdequacy = assessArticleSampleAdequacy(sample)

  const doisToCheck = sample.map(a => a.doi).filter(Boolean).slice(0, doiCheckCount)
  const doiChecks = await runBatch(doisToCheck, doi => checkDoiResolution(doi, { timeoutMs: 10000 }), concurrency, delayMs)

  let oaiPmhCheck = null
  if (journal.oai_base_url) {
    const check = await checkOaiPmhEndpoint(journal.oai_base_url, { timeoutMs: 10000 })
    oaiPmhCheck = { attempted: true, ...check }
  }

  const infrastructureItemStatuses = deriveInfrastructureItemStatuses({ sample, doiChecks, oaiPmhCheck })

  const firstPublicationDate = journal.early_stage_rating?.first_published ?? null
  const windowStats = computePublicationWindowStats(
    allArticles.map(a => a.publishedDate),
    { frequency: journal.frequency ?? null, firstPublicationDate, ratingDate }
  )
  const depositTimeliness = deriveDepositTimeliness(sample)

  return {
    posi_id: journal.posi_id, journal_code: journal.journal_code, title: journal.title,
    issn_queried: issn, crossref_status: 200, total_results: fetchResult.totalResults, works_fetched: allArticles.length,
    article_sample: sample, sample_adequacy: sampleAdequacy,
    infrastructure_item_statuses: infrastructureItemStatuses,
    doi_resolution_checks: doiChecks, oai_pmh_check: oaiPmhCheck,
    publishing_stability: { cadence: windowStats.cadence, continuity: windowStats.continuity, deposit_timeliness: depositTimeliness },
    frequency_disclosed: 'unknown',
    first_publication_date_used: firstPublicationDate,
    works_methodology_version: WORKS_RESOLVER_METHODOLOGY_VERSION,
    snapshot_date: new Date().toISOString().slice(0, 10),
  }
}

async function main() {
  const corpusPath = resolve(arg('corpus'))
  const outDir = resolve(arg('out', 'works-etl-output'))
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const concurrency = parseInt(arg('concurrency', '3'), 10)
  const delayMs = parseInt(arg('delay-ms', '500'), 10)
  const doiCheckCount = parseInt(arg('doi-checks', '10'), 10)
  const ratingDate = arg('rating-date', new Date().toISOString().slice(0, 10))

  if (!corpusPath || !existsSync(corpusPath)) {
    console.error('Usage: node scripts/run-works-etl.mjs --corpus <path to corpus/core-collection.json> --out <dir>')
    process.exit(1)
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer, got: ${arg('concurrency', '3')}`)
    process.exit(1)
  }
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    console.error(`--delay-ms must be a non-negative integer, got: ${arg('delay-ms', '500')}`)
    process.exit(1)
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const journalsOutDir = join(outDir, 'journals')
  if (!existsSync(journalsOutDir)) mkdirSync(journalsOutDir, { recursive: true })

  const corpusRaw = JSON.parse(readFileSync(corpusPath, 'utf-8'))
  const corpus = Array.isArray(corpusRaw) ? corpusRaw : (corpusRaw.journals ?? [])
  const targets = limit ? corpus.slice(0, limit) : corpus
  console.log(`Loaded ${corpus.length} journals from ${corpusPath}${limit ? ` (processing first ${targets.length})` : ''}`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i]
    process.stdout.write(`[${i + 1}/${targets.length}] ${j.title} (${j.posi_id ?? 'NO POSI_ID'}) ... `)
    let result
    try {
      result = await processJournal(j, { concurrency, delayMs, doiCheckCount, ratingDate })
    } catch (err) {
      // Same isolation discipline as run-evidence-etl.mjs: one journal's
      // unexpected failure must never abort the whole batch run.
      console.log(`ERROR (isolated to this journal): ${err?.message ?? err}`)
      result = { ...emptyResult(j, `unexpected error, isolated: ${err?.message ?? err}`) }
    }
    results.push(result)
    writeFileSync(join(journalsOutDir, `${result.posi_id ?? j.journal_code}.json`), JSON.stringify(result, null, 2), 'utf-8')
    console.log(`crossref_status=${result.crossref_status} works_fetched=${result.works_fetched} sample=${result.article_sample.length} (sufficient=${result.sample_adequacy.sufficient})`)
  }

  const summary = {
    input_journals: targets.length,
    journals_with_issn: results.filter(r => r.issn_queried).length,
    journals_with_no_issn: results.filter(r => !r.issn_queried).length,
    journals_with_crossref_404: results.filter(r => r.crossref_status === 404).length,
    journals_with_sufficient_sample: results.filter(r => r.sample_adequacy.sufficient).length,
    journals_meeting_target_sample: results.filter(r => r.sample_adequacy.meets_target).length,
    journals_with_zero_works: results.filter(r => r.works_fetched === 0).length,
    total_works_fetched: results.reduce((s, r) => s + r.works_fetched, 0),
    infrastructure_item_status_counts: (() => {
      const counts = {}
      for (const r of results) {
        for (const [id, status] of Object.entries(r.infrastructure_item_statuses)) {
          counts[id] = counts[id] ?? {}
          counts[id][status] = (counts[id][status] ?? 0) + 1
        }
      }
      return counts
    })(),
    journals_with_computable_cadence: results.filter(r => r.publishing_stability.cadence.expectedWindows > 0).length,
    journals_with_oai_pmh_checked: results.filter(r => r.oai_pmh_check?.attempted).length,
    journals_with_oai_pmh_ok: results.filter(r => r.oai_pmh_check?.ok).length,
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'per-journal-works.csv'),
    ['posi_id,title,issn_queried,crossref_status,total_results,works_fetched,sample_size,sample_sufficient,sample_meets_target']
      .concat(results.map(r => `${r.posi_id},"${(r.title ?? '').replace(/"/g, '""')}",${r.issn_queried ?? ''},${r.crossref_status ?? ''},${r.total_results ?? ''},${r.works_fetched},${r.article_sample.length},${r.sample_adequacy.sufficient},${r.sample_adequacy.meets_target}`))
      .join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
