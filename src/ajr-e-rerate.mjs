/**
 * AJR-E-1.1 rerate pipeline — the piece that was genuinely missing before
 * now: `ajr-early-stage.mjs` (AJR-E-1.1) has been implemented and unit
 * tested since the "POSI Journal Evaluation & Ranking Framework 1.0"
 * engine migration, but had never actually been run against real evidence.
 * This module ties together the two independently-produced evidence
 * sources this project now has (`evidence/journals/` — site-crawl
 * disclosure evidence, Dimensions 1/2/7; `evidence/works/` — Crossref
 * article-sample evidence, Dimensions 3/4/5/6, see `works-fetch.mjs`/
 * `works-resolver.mjs`) into `computeAjrE()`'s single input contract, then
 * applies the framework's own eligibility gate
 * (`evidence-coverage.mjs#ratingEligibility()`) — never a score forced past
 * it.
 *
 * Pure functions only — no I/O, no reading `posi-data` files directly (see
 * `scripts/rerate-core-collection-ajr-e-1.1.mjs` for the orchestrator that
 * loads corpus/evidence JSON and calls into this module).
 *
 * Three independent reasons a journal can end up with no AJR-E-1.1 score,
 * each surfaced distinctly rather than collapsed into one generic
 * "unrated":
 *   1. `rating_status: 'not_applicable'` — the journal's re-derived,
 *      exact-date lifecycle stage (LIFECYCLE-1.1, recomputed at the
 *      CURRENT rating date, not trusted from a stale prior rating) is not
 *      currently `early_stage`. Real, expected finding: a journal rated
 *      `early_stage` under AJR-E-1.0 may have used the older, buggy
 *      calendar-month lifecycle boundary check that LIFECYCLE-1.1 fixed,
 *      or may simply have aged out into Mature since the 1.0 pass.
 *   2. `rating_status: 'not_rateable'` — lifecycle stage is `early_stage`,
 *      but the framework's own mandatory-evidence bar
 *      (`determineMandatoryEvidenceResolved()`) isn't cleared (e.g. the
 *      Article-Sample ETL found fewer than the minimum 10 articles) —
 *      `ratingEligibility()` returns `not_rateable` regardless of overall
 *      coverage percentage.
 *   3. `rating_status: 'not_rateable'` via low Evidence Coverage (<60%,
 *      `EC_PROVISIONAL_THRESHOLD`) even with mandatory evidence resolved.
 */

import { classifyLifecycle } from './lifecycle.mjs'
import { computeAjrE, AJR_E_METHODOLOGY_VERSION } from './ajr-early-stage.mjs'
import { ratingEligibility, EC_PROVISIONAL_THRESHOLD } from './evidence-coverage.mjs'

/**
 * @param {{ id: string, status: string }[]} evidenceItems
 * @returns {Object<string,string>} id -> status, ready for
 *   scoreEditorialGovernance()/scoreResearchIntegrity()/scoreTransparency()
 *   (each only reads the ids its own dimension defines; passing the SAME
 *   full map to all three is safe and correct, not a shortcut — every id
 *   across the site-crawl evidence package is globally unique).
 */
export function itemStatusMap(evidenceItems) {
  const map = {}
  for (const item of evidenceItems ?? []) map[item.id] = item.status
  return map
}

function round2(n) { return Math.round(n * 100) / 100 }

/**
 * Blends every evidence-item-BACKED sub-score's coverage into one overall
 * percentage. SCOPE, documented (judgment call, same disclosure style this
 * codebase already uses elsewhere): only Dimensions 1/2/3/7 plus Dimension
 * 4's two disclosure items (frequency_disclosed, deposit_timeliness) are
 * "evidence items" with a Met/NotMet/Unknown/... status in this
 * implementation. Dimension 4's cadence/continuity/output sub-scores and
 * all of Dimensions 5/6 are direct NUMERIC computations from article data
 * (a formula result, or `null` when not computable) — they were never
 * evidence-coverage items to begin with, so they are not folded into this
 * percentage. Their own "was this even computable" signal
 * (`sample_adequacy`, `cadence.expectedWindows > 0`) is a separate,
 * already-surfaced concept, not silently merged into Evidence Coverage.
 * @param {ReturnType<typeof computeAjrE>} ajrEResult
 * @returns {{ coverage_percent: number, applicable_weight: number, resolved_weight: number, met_weight: number }}
 */
export function aggregateOverallEvidenceCoverage(ajrEResult) {
  const s = ajrEResult.subfactors
  const parts = [
    s.egf.coverage, s.rif.coverage, s.inf.coverage, s.trn.coverage,
    s.pub.subfactors.frequency_disclosed.coverage,
    s.pub.subfactors.deposit_timeliness.coverage,
  ]
  const applicable_weight = parts.reduce((sum, c) => sum + c.applicable_weight, 0)
  const resolved_weight = parts.reduce((sum, c) => sum + c.resolved_weight, 0)
  const met_weight = parts.reduce((sum, c) => sum + c.met_weight, 0)
  return {
    coverage_percent: applicable_weight > 0 ? round2((resolved_weight / applicable_weight) * 100) : 0,
    applicable_weight, resolved_weight, met_weight,
  }
}

/**
 * AJR-SPEC.md § 6's mandatory-evidence bar, as far as this pipeline can
 * actually check it: "journal identity, ISSN, publication age, an article
 * sample, lifecycle classification, absence of a known severe integrity
 * issue." `psc_category`/`psc_confidence` are deliberately NOT checked
 * here — the spec's mandatory-evidence list does not name PSC at all; PSC
 * confidence is a separate gate that only decides E-Q COHORT membership
 * (`cohort.mjs`), not whether a score exists in the first place.
 *
 * KNOWN LIMITATION, documented rather than silently assumed: "absence of a
 * known severe integrity issue" is trivially treated as satisfied here —
 * no citation-integrity review pipeline exists for Early-Stage journals in
 * this codebase (`citation-integrity.mjs`'s checks are built for AJR-M's
 * accumulated-citation-history journals, not brand-new Early-Stage ones
 * with little/no citation graph yet). Absence of a code path that could
 * flag an issue is not strong evidence none exists — flagged here so a
 * reviewer can see exactly what this gate does and does not check.
 * @param {{ hasIssn: boolean, lifecycleStage: string, sampleAdequacy: { sufficient: boolean, size: number } }} input
 * @returns {{ resolved: boolean, reasons: string[] }}
 */
export function determineMandatoryEvidenceResolved({ hasIssn, lifecycleStage, sampleAdequacy }) {
  const reasons = []
  if (!hasIssn) reasons.push('no ISSN on record')
  if (lifecycleStage !== 'early_stage') reasons.push(`lifecycle stage is '${lifecycleStage}', not early_stage`)
  if (!sampleAdequacy?.sufficient) reasons.push(`article sample of ${sampleAdequacy?.size ?? 0} is below the AJR-E-1.1 minimum of 10 (AJR-E-1.1-SPEC.md § 7)`)
  return { resolved: reasons.length === 0, reasons }
}

/**
 * Rates one journal end-to-end: re-derives lifecycle stage authoritatively
 * (never trusts a possibly-stale prior rating's stage label), assembles
 * `computeAjrE()`'s input from the two evidence sources, applies the
 * mandatory-evidence + Evidence Coverage eligibility gate, and returns a
 * `corpus/core-collection.json`-shaped `early_stage_rating` object minus
 * the E-Q ranking fields (quartile/cohort/*) — those require cross-journal
 * cohort data and are filled in by the orchestrator script after every
 * journal in the corpus has been rated once.
 *
 * @param {{
 *   journal: { posi_id: string, issn_online: string|null, issn_print: string|null, frequency: string|null, early_stage_rating?: { first_published: string|null } },
 *   journalEvidence: { evidence_items: { id: string, status: string }[] } | null,
 *   worksEvidence: {
 *     total_results: number|null, article_sample: object[], sample_adequacy: { sufficient: boolean, size: number },
 *     infrastructure_item_statuses: Object<string,string>,
 *     publishing_stability: { cadence: object, continuity: object, deposit_timeliness: string },
 *   } | null,
 *   ratingDate: Date,
 * }} input
 * @returns {object} early_stage_rating fields (without quartile/cohort_*)
 */
export function rateJournal({ journal, journalEvidence, worksEvidence, ratingDate }) {
  const firstPublished = journal.early_stage_rating?.first_published ?? null
  const lifecycle = classifyLifecycle(firstPublished, ratingDate)
  const ratedAt = ratingDate.toISOString().slice(0, 10)
  const hasIssn = Boolean(journal.issn_online || journal.issn_print)
  const sampleAdequacy = worksEvidence?.sample_adequacy ?? { sufficient: false, size: 0, meets_target: false, spans_multiple_periods: false, note: 'no Article-Sample ETL data on record' }

  const base = {
    lifecycle_stage: lifecycle.lifecycle_stage,
    months_since_launch: lifecycle.months_since_launch,
    first_published: firstPublished,
    sample_adequacy: sampleAdequacy,
    quartile: null, quartile_label: null, cohort_key: null, cohort_level: null, cohort_size: null, ranking_method: null,
    rated_at: ratedAt,
    version: AJR_E_METHODOLOGY_VERSION,
  }

  if (lifecycle.lifecycle_stage !== 'early_stage') {
    return {
      ...base,
      rating_status: 'not_applicable',
      not_rateable_reason: `AJR-E applies only to the Early-Stage window (12-59 months, LIFECYCLE-1.1 exact-date boundary); this journal is currently '${lifecycle.lifecycle_stage}' as of ${ratedAt}`,
      subfactors: null, total: null, evidence_coverage: null,
    }
  }

  const siteItemStatuses = itemStatusMap(journalEvidence?.evidence_items ?? [])
  const infrastructureItemStatuses = worksEvidence?.infrastructure_item_statuses ?? {}
  const articles = worksEvidence?.article_sample ?? []
  const cadence = worksEvidence?.publishing_stability?.cadence ?? { expectedWindows: 0, metWindows: 0 }
  const continuity = worksEvidence?.publishing_stability?.continuity ?? { totalWindows: 0, activeWindows: 0 }
  const depositTimeliness = worksEvidence?.publishing_stability?.deposit_timeliness ?? 'unknown'
  const totalArticleCount = worksEvidence?.total_results ?? 0

  const ajrEInput = {
    editorialGovernance: siteItemStatuses,
    researchIntegrity: siteItemStatuses,
    infrastructure: infrastructureItemStatuses,
    publishingStability: {
      // frequency_disclosed is always 'unknown' -- deliberately not
      // resolved anywhere in this pipeline yet, see works-resolver.mjs's
      // header for why (a website-crawl question, not an article-data
      // one; a known, separate, still-open gap).
      evidence: { frequency_disclosed: 'unknown', deposit_timeliness: depositTimeliness },
      cadence, continuity,
      output: { articleCount: totalArticleCount, monthsSinceLaunch: lifecycle.months_since_launch },
    },
    articles,
    transparency: siteItemStatuses,
  }

  const ajrE = computeAjrE(ajrEInput)
  const coverage = aggregateOverallEvidenceCoverage(ajrE)
  const mandatory = determineMandatoryEvidenceResolved({ hasIssn, lifecycleStage: lifecycle.lifecycle_stage, sampleAdequacy })
  const ratingStatus = ratingEligibility(coverage.coverage_percent, mandatory.resolved)

  const subfactors = {
    egf: ajrE.subfactors.egf.score, rif: ajrE.subfactors.rif.score, inf: ajrE.subfactors.inf.score,
    pub: ajrE.subfactors.pub.score, soc: ajrE.subfactors.soc.score, rdc: ajrE.subfactors.rdc.score, trn: ajrE.subfactors.trn.score,
  }

  let notRateableReason = null
  if (ratingStatus === 'not_rateable') {
    notRateableReason = !mandatory.resolved
      ? `mandatory evidence not resolved: ${mandatory.reasons.join('; ')}`
      : `evidence coverage ${coverage.coverage_percent}% is below the not-rateable threshold of ${EC_PROVISIONAL_THRESHOLD}%`
  }

  const showScore = ratingStatus !== 'not_rateable'
  return {
    ...base,
    rating_status: ratingStatus,
    not_rateable_reason: notRateableReason,
    subfactors: showScore ? subfactors : null,
    total: showScore ? ajrE.total : null,
    evidence_coverage: coverage.coverage_percent,
  }
}
