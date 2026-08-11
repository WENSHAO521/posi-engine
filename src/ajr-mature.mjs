/**
 * AJR-M — POSI Automated Journal Rating, Mature model (60+ months).
 * Implements the "POSI Journal Evaluation & Ranking Framework 1.0" AJR-M
 * section. **AJR-M 1.0 — this model DOES NOT EXIST before this module.**
 * Mature journals were previously scored with the AJR-E rubric as an
 * interim measure (posi-data/AJR-SPEC.md § 3's stated motivation for why
 * that's wrong: a mature journal's decades of real citation history is
 * exactly the data AJR-E has no way to use). This module makes that
 * interim measure unnecessary.
 *
 * 100 points, 6 dimensions:
 *   1. Citation Performance & Field-Normalized Impact       35
 *   2. Scholarly Output & Publishing Stability               20
 *   3. Editorial Governance & Research Integrity              15
 *   4. Metadata & Digital Infrastructure                     10
 *   5. Scholarly Reach & Concentration                        10
 *   6. Transparency & Access Policy                           10
 *
 * Dimension 1 (Citation Performance) is the flagship, largest single
 * block, and the thing that makes AJR-M structurally different from
 * AJR-E: it converts PCI/PCI-5/PNCI into WITHIN-PRIMARY-PSC percentiles
 * (via quartile-tracks.mjs's percentileMidrank(), the same midrank core
 * E-Q/M-Q/Citation-Q all share) before scoring, specifically so a
 * naturally-high-citation field (medicine) doesn't structurally dominate a
 * naturally-low-citation field (history) — see computeCitationPercentiles().
 *
 * Dimension 6 (Transparency) is shared verbatim with AJR-E's dimension 7
 * via shared-dimensions.mjs, per the framework's explicit instruction
 * ("same criteria as AJR-E dimension 7").
 *
 * "Severe citation anomalies do NOT get scored down [in Reach &
 * Concentration] — they route to Citation Integrity / Suppression
 * instead" (framework, verbatim) — see gateAjrMByIntegrity() at the bottom
 * of this module, which is the ONLY place a citation-integrity finding
 * touches an AJR-M result, and it never subtracts points; it replaces the
 * whole result with a "not officially rankable" verdict.
 *
 * Pure functions throughout, same separation-of-concerns as every other
 * module here: no I/O, no external state.
 */

import { dimensionScore } from './evidence-coverage.mjs'
import { scoreTransparency } from './shared-dimensions.mjs'
import { percentileMidrank } from './quartile-tracks.mjs'

export const AJR_M_METHODOLOGY_VERSION = 'AJR-M-1.0'

export function clamp(v, max) { return Math.max(0, Math.min(v, max)) }
function round2(n) { return Math.round(n * 100) / 100 }

// ---------------------------------------------------------------------
// Dimension 1 — Citation Performance & Field-Normalized Impact (35)
// ---------------------------------------------------------------------

export const CITATION_PERFORMANCE_WEIGHT = 35
const S_PCI_MAX = 15
const S_PCI5_MAX = 10
const S_PNCI_MAX = 10

/**
 * Converts PCI, PCI-5, and PNCI to within-Primary-PSC percentiles, for a
 * single metric_year. Reuses quartile-tracks.mjs's percentileMidrank() —
 * the SAME midrank algorithm E-Q/M-Q/Citation-Q use — applied three times
 * (once per metric), rather than a fourth, bespoke percentile
 * implementation.
 * @param {{ journal_id: string, pci: number|null, pci_5yr: number|null, pnci: number|null }[]} categoryEntries
 *   - every metric-eligible journal in the SAME primary PSC category and
 *   metric_year as the journal being scored (the journal itself must be
 *   included in this list to get its own percentile).
 * @param {string} journalId
 * @returns {{ percentile_pci: number|null, percentile_pci5: number|null, percentile_pnci: number|null }}
 */
export function computeCitationPercentiles(categoryEntries, journalId) {
  return {
    percentile_pci: percentileFor(categoryEntries, journalId, 'pci'),
    percentile_pci5: percentileFor(categoryEntries, journalId, 'pci_5yr'),
    percentile_pnci: percentileFor(categoryEntries, journalId, 'pnci'),
  }
}

function percentileFor(categoryEntries, journalId, field) {
  const withValue = categoryEntries.filter(e => e[field] != null).map(e => ({ id: e.journal_id, value: e[field] }))
  if (withValue.length === 0 || !withValue.some(e => e.id === journalId)) return null
  const records = percentileMidrank(withValue)
  return records.find(r => r.id === journalId)?.percentile ?? null
}

/**
 * S_PCI = 15 * percentile_PCI/100, S_PCI5 = 10 * percentile_PCI5/100,
 * S_PNCI = 10 * percentile_PNCI/100. A null percentile (not enough peer
 * data to place this journal, or this journal has no value for that
 * metric) contributes 0 to that sub-score AND is excluded from the
 * component's own internal "how much of the 35 could even be computed"
 * bookkeeping (`computable_max`) — so a journal missing PCI-5 history
 * isn't punished as if it scored zero on a metric it does have (PCI
 * itself), only genuinely not credited for the piece it can't show.
 * @param {{ percentile_pci: number|null, percentile_pci5: number|null, percentile_pnci: number|null }} percentiles
 * @returns {{ score: number, computable_max: number, subfactors: object }}
 */
export function scoreCitationPerformance(percentiles) {
  const sPci = percentiles.percentile_pci != null ? S_PCI_MAX * (percentiles.percentile_pci / 100) : null
  const sPci5 = percentiles.percentile_pci5 != null ? S_PCI5_MAX * (percentiles.percentile_pci5 / 100) : null
  const sPnci = percentiles.percentile_pnci != null ? S_PNCI_MAX * (percentiles.percentile_pnci / 100) : null

  const parts = [sPci, sPci5, sPnci]
  const score = round2(parts.reduce((s, p) => s + (p ?? 0), 0))
  const computableMax = (sPci != null ? S_PCI_MAX : 0) + (sPci5 != null ? S_PCI5_MAX : 0) + (sPnci != null ? S_PNCI_MAX : 0)

  return {
    score: clamp(score, CITATION_PERFORMANCE_WEIGHT),
    computable_max: computableMax,
    subfactors: { s_pci: sPci, s_pci5: sPci5, s_pnci: sPnci },
  }
}

// ---------------------------------------------------------------------
// Dimension 2 — Scholarly Output & Publishing Stability (20)
// ---------------------------------------------------------------------

export const OUTPUT_STABILITY_WEIGHT = 20
const CONTINUITY_5YR_WEIGHT = 4
const OUTPUT_STABILITY_CV_WEIGHT = 4
const SCHEDULE_ADHERENCE_WEIGHT = 3
const STRUCTURAL_METADATA_WEIGHT = 4
const DEPOSIT_TIMELINESS_WEIGHT = 3
const DATE_CONSISTENCY_WEIGHT = 2

/**
 * Five-year publication continuity (4 pts) — proportional share of the
 * last 5 years with at least one qualifying publication.
 * @param {boolean[]} yearsWithOutput - exactly 5 booleans, most recent 5 years
 */
export function scoreFiveYearContinuity(yearsWithOutput) {
  if (!yearsWithOutput || yearsWithOutput.length === 0) return { score: null, ratio: null }
  const ratio = yearsWithOutput.filter(Boolean).length / yearsWithOutput.length
  return { score: round2(CONTINUITY_5YR_WEIGHT * ratio), ratio }
}

/**
 * Annual output stability (4 pts) — via coefficient of variation (CV =
 * stddev/mean) of yearly output counts, LOWER CV is more stable and scores
 * higher. "Calibrated by field/access-model rather than 'more articles is
 * better'" (framework) — this function does not reward volume at all,
 * only consistency; the caller may pass a field-specific `cvBenchmark`
 * (JUDGMENT CALL, flagged: the framework asks for field/access-model
 * calibration but gives no concrete CV benchmark table — a single
 * conservative default is used when the caller doesn't supply one, and any
 * caller wanting real per-field calibration must supply cvBenchmark
 * itself; this module does not invent field-specific CV tables it has no
 * evidentiary basis for).
 * @param {number[]} annualOutputCounts - at least 2 years of article counts
 * @param {number} [cvBenchmark=0.5] - a CV at or below this scores full marks;
 *   scales linearly to 0 at 2x the benchmark.
 */
export function scoreOutputStability(annualOutputCounts, cvBenchmark = 0.5) {
  if (!annualOutputCounts || annualOutputCounts.length < 2) return { score: null, cv: null }
  const mean = annualOutputCounts.reduce((s, n) => s + n, 0) / annualOutputCounts.length
  if (mean === 0) return { score: 0, cv: null }
  const variance = annualOutputCounts.reduce((s, n) => s + (n - mean) ** 2, 0) / annualOutputCounts.length
  const cv = Math.sqrt(variance) / mean
  const ratio = clamp(1 - cv / (2 * cvBenchmark), 1)
  return { score: round2(OUTPUT_STABILITY_CV_WEIGHT * Math.max(0, ratio)), cv: round2(cv) }
}

/**
 * Publication schedule adherence (3 pts) — reuses the same tiered ratio
 * shape as AJR-E's cadence match, scaled to this dimension's 3-point
 * weight (>=90% -> full, 75-89% -> 80%, 60-74% -> ~40%, <60% -> 0),
 * consistent with AJR-E's cadence tiers rather than inventing a different
 * curve for the same underlying question.
 */
export function scoreScheduleAdherence(expectedWindows, metWindows) {
  if (!expectedWindows || expectedWindows <= 0) return { score: null, ratio: null }
  const ratio = clamp(metWindows, expectedWindows) / expectedWindows
  let fraction
  if (ratio >= 0.90) fraction = 1
  else if (ratio >= 0.75) fraction = 0.8
  else if (ratio >= 0.60) fraction = 0.4
  else fraction = 0
  return { score: round2(SCHEDULE_ADHERENCE_WEIGHT * fraction), ratio }
}

/**
 * @param {{
 *   continuity5yr: boolean[],
 *   annualOutputCounts: number[],
 *   cvBenchmark?: number,
 *   schedule: { expectedWindows: number, metWindows: number },
 *   structuralMetadataStatus: 'met'|'not_met'|'unknown'|'blocked'|'not_applicable'|'conflicted'|'stale',
 *   depositTimelinessStatus: string,
 *   dateConsistencyStatus: string,
 * }} input - the last three are each a SINGLE evidence-coverage status
 *   (article structural/metadata quality, DOI deposit timeliness, and
 *   publication/date consistency are each one evidence check in the
 *   framework's breakdown, not a multi-item sub-checklist — unlike e.g.
 *   AJR-E's Editorial Governance, which genuinely lists several distinct
 *   named checks).
 */
export function scoreOutputAndStability(input) {
  const continuity = scoreFiveYearContinuity(input.continuity5yr)
  const stability = scoreOutputStability(input.annualOutputCounts, input.cvBenchmark)
  const schedule = scoreScheduleAdherence(input.schedule?.expectedWindows, input.schedule?.metWindows)

  const structural = dimensionScore([{ id: 'structural_metadata_quality', weight: STRUCTURAL_METADATA_WEIGHT, status: input.structuralMetadataStatus ?? 'unknown' }], STRUCTURAL_METADATA_WEIGHT)
  const deposit = dimensionScore([{ id: 'deposit_timeliness', weight: DEPOSIT_TIMELINESS_WEIGHT, status: input.depositTimelinessStatus ?? 'unknown' }], DEPOSIT_TIMELINESS_WEIGHT)
  const date = dimensionScore([{ id: 'date_consistency', weight: DATE_CONSISTENCY_WEIGHT, status: input.dateConsistencyStatus ?? 'unknown' }], DATE_CONSISTENCY_WEIGHT)

  const total = round2(
    (continuity.score ?? 0) + (stability.score ?? 0) + (schedule.score ?? 0) + structural.score + deposit.score + date.score
  )

  return {
    score: clamp(total, OUTPUT_STABILITY_WEIGHT),
    subfactors: {
      five_year_continuity: continuity,
      annual_output_stability: stability,
      schedule_adherence: schedule,
      structural_metadata_quality: structural,
      deposit_timeliness: deposit,
      date_consistency: date,
    },
  }
}

// ---------------------------------------------------------------------
// Dimension 3 — Editorial Governance & Research Integrity (15)
// ---------------------------------------------------------------------

export const GOVERNANCE_INTEGRITY_WEIGHT = 15
export const GOVERNANCE_INTEGRITY_ITEMS = Object.freeze([
  { id: 'editorial_governance', weight: 4 },
  { id: 'peer_review_transparency', weight: 3 },
  { id: 'retraction_correction_integrity_framework', weight: 3 },
  { id: 'authorship_coi', weight: 2 },
  { id: 'research_data_ethics', weight: 2 },
  { id: 'ai_policy', weight: 1 },
])

/** @param {Object<string,string>} itemStatuses - keyed by GOVERNANCE_INTEGRITY_ITEMS[].id */
export function scoreGovernanceIntegrity(itemStatuses = {}) {
  const items = GOVERNANCE_INTEGRITY_ITEMS.map(s => ({ id: s.id, weight: s.weight, status: itemStatuses[s.id] ?? 'unknown' }))
  return { ...dimensionScore(items, GOVERNANCE_INTEGRITY_WEIGHT), items }
}

// ---------------------------------------------------------------------
// Dimension 4 — Metadata & Digital Infrastructure (10)
// ---------------------------------------------------------------------

export const AJRM_INFRASTRUCTURE_WEIGHT = 10
export const AJRM_INFRASTRUCTURE_ITEMS = Object.freeze([
  { id: 'doi_reliability', weight: 2 },
  { id: 'metadata_completeness', weight: 2 },
  { id: 'structured_harvesting', weight: 2 },
  { id: 'reference_metadata', weight: 1 },
  { id: 'long_term_preservation', weight: 2 },
  { id: 'stable_urls_https', weight: 1 },
])

/** @param {Object<string,string>} itemStatuses - keyed by AJRM_INFRASTRUCTURE_ITEMS[].id */
export function scoreAjrMInfrastructure(itemStatuses = {}) {
  const items = AJRM_INFRASTRUCTURE_ITEMS.map(s => ({ id: s.id, weight: s.weight, status: itemStatuses[s.id] ?? 'unknown' }))
  return { ...dimensionScore(items, AJRM_INFRASTRUCTURE_WEIGHT), items }
}

// ---------------------------------------------------------------------
// Dimension 5 — Scholarly Reach & Concentration (10)
// ---------------------------------------------------------------------

export const AJRM_REACH_CONCENTRATION_WEIGHT = 10

function tierShare(share, tiers) {
  for (const [max, points] of tiers) if (share <= max) return points
  return 0
}

const AUTHOR_CONCENTRATION_TIERS = [[0.25, 3], [0.40, 2], [0.60, 1]]
const INSTITUTION_CONCENTRATION_TIERS = [[0.40, 3], [0.60, 2], [0.80, 1]]
const CITING_SOURCE_CONCENTRATION_TIERS = [[0.40, 2], [0.60, 1]]

/**
 * Author concentration (3) + institution concentration (3) + collaboration
 * breadth (2) + citing-source concentration (2). "Severe citation
 * anomalies do NOT get scored down here — they route to Citation
 * Integrity / Suppression instead" (framework) — this function has no
 * integrity-flag input at all, by design; see gateAjrMByIntegrity().
 * @param {{
 *   maxAuthorShare: number|null,          // share of output attributable to the single most-recurrent identifiable author (ORCID/name — see ajr-early-stage.mjs's resolveAuthorIdentity, reused by convention, not re-implemented here)
 *   maxInstitutionShare: number|null,
 *   uniqueInstitutionRatio: number|null,  // for collaboration breadth
 *   maxCitingSourceShare: number|null,    // share of inbound citations from the single largest citing journal
 * }} input
 */
export function scoreReachConcentrationMature(input) {
  const authorScore = input.maxAuthorShare != null ? tierShare(input.maxAuthorShare, AUTHOR_CONCENTRATION_TIERS) : 1.5
  const institutionScore = input.maxInstitutionShare != null ? tierShare(input.maxInstitutionShare, INSTITUTION_CONCENTRATION_TIERS) : 1.5
  const breadthScore = input.uniqueInstitutionRatio != null ? round2(2 * clamp(input.uniqueInstitutionRatio, 1)) : 1
  const citingSourceScore = input.maxCitingSourceShare != null ? tierShare(input.maxCitingSourceShare, CITING_SOURCE_CONCENTRATION_TIERS) : 1

  const total = round2(authorScore + institutionScore + breadthScore + citingSourceScore)
  return {
    score: clamp(total, AJRM_REACH_CONCENTRATION_WEIGHT),
    subfactors: {
      author_concentration: authorScore,
      institution_concentration: institutionScore,
      collaboration_breadth: breadthScore,
      citing_source_concentration: citingSourceScore,
    },
  }
}

// ---------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------

/**
 * Combines all 6 dimensions into the AJR-M 1.0 total (100 points).
 * Callers are expected to have already gated eligibility (Evidence
 * Coverage thresholds, mandatory evidence, mature lifecycle stage) — see
 * evidence-coverage.mjs's ratingEligibility() — and to have already
 * resolved citation integrity via gateAjrMByIntegrity() below (this
 * function computes the raw score; the integrity gate wraps it).
 *
 * @param {{
 *   citationPercentiles: { percentile_pci: number|null, percentile_pci5: number|null, percentile_pnci: number|null },
 *   outputStability: Parameters<typeof scoreOutputAndStability>[0],
 *   governanceIntegrity: Object<string,string>,
 *   infrastructure: Object<string,string>,
 *   reachConcentration: Parameters<typeof scoreReachConcentrationMature>[0],
 *   transparency: Object<string,string>,
 * }} input
 */
export function computeAjrM(input) {
  const citation = scoreCitationPerformance(input.citationPercentiles)
  const output = scoreOutputAndStability(input.outputStability)
  const governance = scoreGovernanceIntegrity(input.governanceIntegrity)
  const infrastructure = scoreAjrMInfrastructure(input.infrastructure)
  const reach = scoreReachConcentrationMature(input.reachConcentration)
  const transparency = scoreTransparency(input.transparency)

  const total = round2(citation.score + output.score + governance.score + infrastructure.score + reach.score + transparency.score)

  return {
    subfactors: { citation, output, governance, infrastructure, reach, transparency },
    total,
    methodology_version: AJR_M_METHODOLOGY_VERSION,
  }
}

// ---------------------------------------------------------------------
// Citation-integrity gate (never a point deduction — a replacement verdict)
// ---------------------------------------------------------------------

/**
 * "If suppressed: PCI/PCI-5/PNCI/Citation Q/M-Q show 'suppressed' with the
 * specific reason; AJR-M becomes 'not officially rankable.'" (framework,
 * verbatim). This is the ONLY function in this module that citation
 * integrity is allowed to touch — it never edits any dimension score; it
 * either passes the computed AJR-M result through unchanged or replaces
 * the whole thing with a suppressed verdict.
 * @param {ReturnType<typeof computeAjrM>} ajrMResult
 * @param {{ flagged: boolean, flagged_checks?: string[] }} integrityVerdict
 *   - e.g. citation-integrity.mjs's evaluateIntegrity() output, AFTER
 *   human review has confirmed suppression (per PJR-SPEC.md § 9 — a raw
 *   flag alone does not suppress; this function's caller is responsible
 *   for only passing a POST-REVIEW suppression decision, not a bare flag).
 * @returns {{ status: 'rankable', result: object } | { status: 'not_officially_rankable', reason: string, flagged_checks: string[] }}
 */
export function gateAjrMByIntegrity(ajrMResult, integrityVerdict) {
  if (!integrityVerdict?.flagged) {
    return { status: 'rankable', result: ajrMResult }
  }
  return {
    status: 'not_officially_rankable',
    reason: 'citation integrity review resulted in suppression — see flagged_checks',
    flagged_checks: integrityVerdict.flagged_checks ?? [],
  }
}
