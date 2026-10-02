#!/usr/bin/env node
/**
 * rate-mature.mjs — runs AJR-M-1.0 (`src/ajr-m-rerate.mjs`) over a corpus
 * file (corpus/core-collection.json or corpus/global-benchmark.json).
 *
 * Every journal whose exact-date lifecycle stage is Mature (60+ months,
 * LIFECYCLE-1.1) gets a `mature_rating` (posi-data schema/rating.schema.json,
 * track `mature`); a journal that is not Mature has any `mature_rating`
 * removed, so no record carries a rating for a track it is not on.
 * `early_stage_rating` is left as it is (rerate-core-collection-ajr-e-1.1.mjs
 * marks Mature journals `not_applicable` there).
 *
 * Reads:
 *   --corpus              corpus JSON (array, or { journals: [...] })
 *   --evidence-journals   posi-data evidence/journals
 *   --evidence-works      posi-data evidence/works
 *   --citation-ranking    rankings/citation/citation-ranking-<year>.json[.gz]
 *   --pci                 PCI records: collections/pci.json, or a directory of
 *                         per-journal JSON files (the PCI audit's pci/ shards)
 *   --suppressions        optional JSON { "<posi_id>": ["<flagged check>", ...] }:
 *                         journals whose citation-integrity review confirmed
 *                         suppression (PJR-SPEC.md § 9). A raw flag is not a
 *                         suppression and does not belong here.
 * Writes:
 *   --out-corpus          the corpus with mature_rating set (may be --corpus itself)
 *   --out-report          directory for rate-mature-summary.json and per-journal-mature.csv
 * Options:
 *   --rating-date YYYY-MM-DD   (default today)
 *   --offline                  skip OpenAlex; every journal then lacks output history
 *   --delay-ms 120             pause between OpenAlex requests
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { gunzipSync } from 'zlib'
import { resolve, join } from 'path'
import { rateMatureJournal, buildCitationPeerSets } from '../src/ajr-m-rerate.mjs'
import { classifyLifecycle } from '../src/lifecycle.mjs'
import { fetchCountsByYear } from '../src/output-history.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function readJson(path) {
  const buf = readFileSync(path)
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf-8'))
}

function loadJsonIfExists(path) {
  return existsSync(path) ? readJson(path) : null
}

function readJsonTree(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...readJsonTree(p))
    else if (name.endsWith('.json')) out.push(readJson(p))
  }
  return out
}

async function main() {
  const required = ['corpus', 'evidence-journals', 'evidence-works', 'citation-ranking', 'pci', 'out-corpus', 'out-report']
  const missing = required.filter(n => !arg(n))
  if (missing.length) {
    console.error(`Missing --${missing.join(', --')}. See the header of scripts/rate-mature.mjs for usage.`)
    process.exit(1)
  }
  const corpusPath = resolve(arg('corpus'))
  const evidenceJournalsDir = resolve(arg('evidence-journals'))
  const evidenceWorksDir = resolve(arg('evidence-works'))
  const pciPath = resolve(arg('pci'))
  const outReportDir = resolve(arg('out-report'))
  const ratingDate = new Date(`${arg('rating-date', new Date().toISOString().slice(0, 10))}T00:00:00Z`)
  const offline = process.argv.includes('--offline')
  const delayMs = Number(arg('delay-ms', '120'))
  const suppressions = arg('suppressions') ? readJson(resolve(arg('suppressions'))) : {}

  const corpusRaw = readJson(corpusPath)
  const journals = Array.isArray(corpusRaw) ? corpusRaw : (corpusRaw.journals ?? [])
  const ranking = readJson(resolve(arg('citation-ranking')))
  const pciRecords = statSync(pciPath).isDirectory() ? readJsonTree(pciPath) : readJson(pciPath)
  const peerSets = buildCitationPeerSets(ranking.records ?? ranking, pciRecords)
  console.log(`Loaded ${journals.length} journals, ${(ranking.records ?? ranking).length} ranking records, ${pciRecords.length} PCI records`)
  console.log(`Rating date: ${ratingDate.toISOString().slice(0, 10)}${offline ? ' (offline: no output history)' : ''}`)

  const rows = []
  const updated = []
  for (const journal of journals) {
    const stage = classifyLifecycle(journal.early_stage_rating?.first_published ?? null, ratingDate).lifecycle_stage
    if (stage !== 'mature') {
      const { mature_rating, ...rest } = journal
      updated.push(rest)
      continue
    }
    let countsByYear = null, historyError = 'offline'
    if (!offline) {
      const r = await fetchCountsByYear(journal.openalex_source_id)
      countsByYear = r.counts_by_year
      historyError = r.error
      if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs))
    }
    const flagged = suppressions[journal.posi_id]
    let result
    try {
      result = rateMatureJournal({
        journal,
        journalEvidence: loadJsonIfExists(join(evidenceJournalsDir, `${journal.posi_id}.json`)),
        worksEvidence: loadJsonIfExists(join(evidenceWorksDir, `${journal.posi_id}.json`)),
        peerSets,
        countsByYear,
        integrityVerdict: flagged ? { flagged: true, flagged_checks: flagged } : null,
        ratingDate,
      })
    } catch (err) {
      // One journal's failure never aborts the batch (same isolation as the AJR-E rerate).
      console.log(`[${journal.posi_id}] ERROR (isolated): ${err?.message ?? err}`)
      updated.push(journal)
      rows.push({ posi_id: journal.posi_id, title: journal.title, status: 'error', total: null, rating: null, coverage: null, reasons: [String(err?.message ?? err)] })
      continue
    }
    const r = result.rating
    if (!countsByYear && historyError) result.reasons.push(`output history: ${historyError}`)
    updated.push({ ...journal, mature_rating: r })
    rows.push({ posi_id: journal.posi_id, title: journal.title, status: r.rating_status, total: r.total_score, rating: r.rating, coverage: r.evidence_coverage_percent, reasons: result.reasons })
    console.log(`[${journal.posi_id}] ${journal.title} -- ${r.rating_status} total=${r.total_score ?? 'n/a'} rating=${r.rating ?? 'n/a'} EC=${r.evidence_coverage_percent}%`)
  }

  const out = Array.isArray(corpusRaw) ? updated : { ...corpusRaw, journals: updated }
  writeFileSync(resolve(arg('out-corpus')), JSON.stringify(out, null, 2) + '\n', 'utf-8')

  const count = key => rows.reduce((m, r) => { const k = r[key] ?? 'n/a'; m[k] = (m[k] ?? 0) + 1; return m }, {})
  const summary = {
    input_journals: journals.length,
    mature_journals: rows.length,
    rating_date: ratingDate.toISOString().slice(0, 10),
    rating_status_counts: count('status'),
    ajr_rating_counts: count('rating'),
  }
  mkdirSync(outReportDir, { recursive: true })
  writeFileSync(join(outReportDir, 'rate-mature-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8')
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  writeFileSync(join(outReportDir, 'per-journal-mature.csv'),
    ['posi_id,title,rating_status,total_score,ajr_rating,evidence_coverage,reasons']
      .concat(rows.map(r => [r.posi_id, esc(r.title), r.status, r.total ?? '', r.rating ?? '', r.coverage ?? '', esc(r.reasons.join('; '))].join(',')))
      .join('\n') + '\n', 'utf-8')

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
