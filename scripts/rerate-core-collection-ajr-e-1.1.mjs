#!/usr/bin/env node
/**
 * rerate-core-collection-ajr-e-1.1.mjs — the actual, real, first-ever run
 * of AJR-E-1.1 (`ajr-early-stage.mjs`) against Core Collection.
 *
 * Combines `posi-data`'s two independently-produced evidence sources:
 *   - evidence/journals/<posi_id>.json  (site-crawl, Dimensions 1/2/7)
 *   - evidence/works/<posi_id>.json     (Crossref article-sample, Dimensions 3/4/5/6)
 * through `src/ajr-e-rerate.mjs`'s `rateJournal()`, which applies the
 * framework's own eligibility gate — never forces a score past it. Then
 * ranks every `official`-status journal into an E-Q cohort via
 * `cohort.mjs`/`quartile-tracks.mjs`'s existing confidence-gate +
 * L3>=20/L2>=20/L1>=30 fallback rules (unmodified — this script does not
 * relax or bypass them).
 *
 * Writes an updated `corpus/core-collection.json` (each journal's
 * `early_stage_rating` replaced) to `--out-corpus`, plus a rerate summary
 * (old AJR-E-1.0 vs new AJR-E-1.1, per journal) to `--out-report`. Does
 * NOT overwrite the input corpus file in place -- the caller decides
 * whether/where to apply the result, same discipline as this project's
 * other migration scripts (e.g. materialize-publisher-expansion-canonical-
 * records-2026.mjs).
 *
 * Usage:
 *   node scripts/rerate-core-collection-ajr-e-1.1.mjs \
 *     --corpus <path to corpus/core-collection.json> \
 *     --evidence-journals <path to evidence/journals dir> \
 *     --evidence-works <path to evidence/works dir> \
 *     --out-corpus <path to write the updated corpus JSON> \
 *     --out-report <path to write the rerate report JSON+CSV> \
 *     [--rating-date 2026-08-14]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { rateJournal } from '../src/ajr-e-rerate.mjs'
import { rankLifecycleTrack } from '../src/quartile-tracks.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function loadJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null
}

function main() {
  const corpusPath = resolve(arg('corpus'))
  const evidenceJournalsDir = resolve(arg('evidence-journals'))
  const evidenceWorksDir = resolve(arg('evidence-works'))
  const outCorpusPath = resolve(arg('out-corpus', 'core-collection.rerated.json'))
  const outReportPath = resolve(arg('out-report', 'rerate-report'))
  const ratingDate = new Date(`${arg('rating-date', new Date().toISOString().slice(0, 10))}T00:00:00Z`)

  if (!existsSync(corpusPath) || !existsSync(evidenceJournalsDir) || !existsSync(evidenceWorksDir)) {
    console.error('Usage: node scripts/rerate-core-collection-ajr-e-1.1.mjs --corpus <path> --evidence-journals <dir> --evidence-works <dir> --out-corpus <path> --out-report <dir>')
    process.exit(1)
  }
  if (!existsSync(outReportPath)) mkdirSync(outReportPath, { recursive: true })

  const corpusRaw = JSON.parse(readFileSync(corpusPath, 'utf-8'))
  const journals = Array.isArray(corpusRaw) ? corpusRaw : (corpusRaw.journals ?? [])
  console.log(`Loaded ${journals.length} journals from ${corpusPath}`)
  console.log(`Rating date: ${ratingDate.toISOString().slice(0, 10)}`)

  // --- Pass 1: rate every journal independently (no cross-journal state yet) ---
  const perJournal = []
  for (const journal of journals) {
    const posiId = journal.posi_id
    const journalEvidence = loadJsonIfExists(join(evidenceJournalsDir, `${posiId}.json`))
    const worksEvidence = loadJsonIfExists(join(evidenceWorksDir, `${posiId}.json`))
    const oldRating = journal.early_stage_rating ?? null

    let newRating
    try {
      newRating = rateJournal({ journal, journalEvidence, worksEvidence, ratingDate })
    } catch (err) {
      // One journal's unexpected failure must never abort the whole batch --
      // same isolation discipline as run-evidence-etl.mjs/run-works-etl.mjs.
      console.log(`[${posiId}] ERROR (isolated): ${err?.message ?? err}`)
      newRating = {
        lifecycle_stage: 'unknown', months_since_launch: null, first_published: journal.early_stage_rating?.first_published ?? null,
        rating_status: 'not_rateable', not_rateable_reason: `unexpected error during rerate, isolated: ${err?.message ?? err}`,
        subfactors: null, total: null, evidence_coverage: null, sample_adequacy: null,
        quartile: null, quartile_label: null, cohort_key: null, cohort_level: null, cohort_size: null, ranking_method: null,
        rated_at: ratingDate.toISOString().slice(0, 10), version: 'AJR-E-1.1',
      }
    }

    perJournal.push({ posi_id: posiId, journal, oldRating, newRating })
    console.log(`[${posiId}] ${journal.title} -- lifecycle=${newRating.lifecycle_stage} rating_status=${newRating.rating_status} total=${newRating.total ?? 'n/a'} (old 1.0 total: ${oldRating?.total ?? 'n/a'})`)
  }

  // --- Pass 2: E-Q ranking, only 'official'-status journals are ranking-eligible ---
  // (AJR-SPEC.md § 6: "60-79.9% Provisional score shown, not eligible for
  // ranking/quartile" -- provisional scores are real and shown, just never
  // fed into a cohort ranking.)
  const officialEntries = perJournal
    .filter(p => p.newRating.rating_status === 'official')
    .map(p => ({ id: p.posi_id, score: p.newRating.total, psc_category: p.journal.psc_category ?? null, psc_confidence: p.journal.psc_confidence ?? null }))

  const metricYear = ratingDate.getUTCFullYear()
  const eqResults = rankLifecycleTrack(officialEntries, 'early_stage', metricYear)
  const eqById = new Map(eqResults.map(r => [r.journal_id, r]))

  for (const p of perJournal) {
    const eq = eqById.get(p.posi_id)
    if (eq) {
      p.newRating.quartile = eq.quartile
      p.newRating.quartile_label = eq.quartile_label
      p.newRating.cohort_key = eq.cohort_key
      p.newRating.cohort_level = eq.cohort_level
      p.newRating.cohort_size = eq.cohort_size
      p.newRating.ranking_method = eq.ranking_method
    }
  }

  // --- Write updated corpus (early_stage_rating replaced, everything else untouched) ---
  const updatedJournals = journals.map(j => {
    const p = perJournal.find(x => x.posi_id === j.posi_id)
    return { ...j, early_stage_rating: p.newRating }
  })
  const updatedCorpus = Array.isArray(corpusRaw) ? updatedJournals : { ...corpusRaw, journals: updatedJournals }
  writeFileSync(outCorpusPath, JSON.stringify(updatedCorpus, null, 2) + '\n', 'utf-8')

  // --- Report ---
  const statusCounts = {}
  for (const p of perJournal) statusCounts[p.newRating.rating_status] = (statusCounts[p.newRating.rating_status] ?? 0) + 1
  const quartileCounts = {}
  for (const p of perJournal) {
    const q = p.newRating.quartile_label ?? (p.newRating.rating_status === 'official' ? 'official_but_no_cohort' : 'n/a')
    quartileCounts[q] = (quartileCounts[q] ?? 0) + 1
  }
  const scoreDeltas = perJournal
    .filter(p => p.newRating.total != null && p.oldRating?.total != null)
    .map(p => ({ posi_id: p.posi_id, old_total: p.oldRating.total, new_total: p.newRating.total, delta: Math.round((p.newRating.total - p.oldRating.total) * 100) / 100 }))

  const summary = {
    input_journals: journals.length,
    rating_date: ratingDate.toISOString().slice(0, 10),
    rating_status_counts: statusCounts,
    quartile_label_counts: quartileCounts,
    official_cohort_eligible_count: officialEntries.length,
    journals_with_both_1_0_and_1_1_totals: scoreDeltas.length,
    mean_score_delta: scoreDeltas.length > 0 ? Math.round((scoreDeltas.reduce((s, d) => s + d.delta, 0) / scoreDeltas.length) * 100) / 100 : null,
  }
  writeFileSync(join(outReportPath, 'rerate-summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  writeFileSync(join(outReportPath, 'per-journal-comparison.csv'),
    ['posi_id,title,old_1_0_total,old_1_0_eligibility,new_lifecycle_stage,new_rating_status,new_1_1_total,delta,evidence_coverage,quartile_label,not_rateable_reason']
      .concat(perJournal.map(p => {
        const r = p.newRating
        const delta = (r.total != null && p.oldRating?.total != null) ? Math.round((r.total - p.oldRating.total) * 100) / 100 : ''
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
        return [
          p.posi_id, esc(p.journal.title), p.oldRating?.total ?? '', p.oldRating?.eligibility ?? '',
          r.lifecycle_stage, r.rating_status, r.total ?? '', delta, r.evidence_coverage ?? '', r.quartile_label ?? '', esc(r.not_rateable_reason),
        ].join(',')
      }))
      .join('\n'),
    'utf-8'
  )

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nUpdated corpus written to ${outCorpusPath}`)
  console.log(`Report written to ${outReportPath}`)
}

main()
