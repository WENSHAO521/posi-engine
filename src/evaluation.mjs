/**
 * POSI Journal Evaluation Architecture 1.0 — the single domain module for
 * every rule that turns a computed number into a published evaluation label.
 * Implements posi-data/POSI-EVAL-1.0-SPEC.md.
 *
 * Five layers, never mixed:
 *   1. PQF                  Core Collection eligibility (admission only, never a rank)
 *   2. AJR                  lifecycle rating: AJR Score + AJR Rating (A+ … D), never a quartile
 *   3. Citation indicators  PCI, PNCI, PCS
 *   4. Citation ranking     rank / percentile / Citation Quartile (Q1–Q4), from PNCI only
 *   5. POSI Zones           Zone 1–4, from the same PNCI percentile, independent of the quartile
 *
 * Q1–Q4 exists in exactly one place: calculateCitationQuartile(). No other
 * function in this module (or in posi-engine) may produce a quartile for AJR,
 * PQF or PCS. Pure functions, no I/O.
 */

export const EVALUATION_VERSION = 'POSI-EVAL-1.0'
export const CITATION_RANK_VERSION = 'CITATION-RANK-1.0'
export const ZONES_VERSION = 'POSI-ZONES-2.0'
export const AJR_RATING_VERSION = 'AJR-RATING-1.0'

// ---------------------------------------------------------------------------
// 1. PQF — Core Collection eligibility
// ---------------------------------------------------------------------------

/** PQF status values, in the order of the score bands below. */
export const PQF_STATUS = Object.freeze(['eligible', 'review_required', 'insufficient_evidence', 'not_eligible'])

export const PQF_STATUS_LABEL = Object.freeze({
  eligible: 'Eligible',
  review_required: 'Review Required',
  insufficient_evidence: 'Insufficient Evidence',
  not_eligible: 'Not Eligible',
})

/**
 * PQF score (0–100) -> Core Collection eligibility status.
 *   >= 70        eligible
 *   50 – 69.99   review_required
 *   40 – 49.99   insufficient_evidence
 *   < 40         not_eligible
 * @param {number|null|undefined} score
 * @returns {'eligible'|'review_required'|'insufficient_evidence'|'not_eligible'|null}
 */
export function getPQFStatus(score) {
  if (!isFiniteNumber(score)) return null
  if (score >= 70) return 'eligible'
  if (score >= 50) return 'review_required'
  if (score >= 40) return 'insufficient_evidence'
  return 'not_eligible'
}

// ---------------------------------------------------------------------------
// 2. AJR — lifecycle rating
// ---------------------------------------------------------------------------

/** Lower bound (inclusive) of each AJR Rating. Scores are 0–100. */
export const AJR_RATING_SCALE = Object.freeze([
  ['A+', 90], ['A', 85], ['A−', 80], ['B+', 75], ['B', 70], ['B−', 65], ['C+', 60], ['C', 50], ['D', 0],
])

/**
 * AJR Score -> AJR Rating. The one and only AJR rating function: every
 * rating POSI publishes comes from here, from the unrounded score. A rating
 * is never derived from a legacy E-Q/M-Q quartile.
 * @param {number|null|undefined} score
 * @returns {'A+'|'A'|'A−'|'B+'|'B'|'B−'|'C+'|'C'|'D'|null}
 */
export function getAJRRating(score) {
  if (!isFiniteNumber(score) || score < 0 || score > 100) return null
  for (const [rating, min] of AJR_RATING_SCALE) if (score >= min) return rating
  return null
}
export const calculateAJRRating = getAJRRating

/** Lifecycle windows, months since first publication. */
export const LIFECYCLE_WINDOWS = Object.freeze({ observation: [0, 11], early_stage: [12, 59], mature: [60, Infinity] })

/**
 * Lifecycle stage -> AJR model.
 * @param {'observation'|'early_stage'|'mature'|'unknown'|null|undefined} stage
 * @returns {'Observation'|'AJR-E'|'AJR-M'|null}
 */
export function getAJRModel(stage) {
  if (stage === 'observation') return 'Observation'
  if (stage === 'early_stage') return 'AJR-E'
  if (stage === 'mature') return 'AJR-M'
  return null
}

/**
 * Months since first publication -> lifecycle stage (0–11 observation,
 * 12–59 early_stage, >= 60 mature).
 * @param {number|null|undefined} months
 */
export function getLifecycleStage(months) {
  if (!isFiniteNumber(months) || months < 0) return 'unknown'
  if (months < 12) return 'observation'
  if (months < 60) return 'early_stage'
  return 'mature'
}

// ---------------------------------------------------------------------------
// 4. Citation ranking — mid-rank, percentile, Citation Quartile
// ---------------------------------------------------------------------------

/** Values closer than this are the same PNCI for ranking (floating-point noise only). */
export const TIE_EPSILON = 1e-9

/**
 * Mid-rank of a tied group occupying positions rStart..rEnd (1-based).
 */
export function calculateMidRank(rStart, rEnd) {
  return (rStart + rEnd) / 2
}

/**
 * Mid-rank percentile, 100 × (N − r_mid + 0.5) / N, clamped to 0–100.
 * Full precision; round only for display.
 */
export function calculatePercentile(rMid, n) {
  if (!isFiniteNumber(rMid) || !isFiniteNumber(n) || n <= 0) return null
  return Math.min(100, Math.max(0, 100 * (n - rMid + 0.5) / n))
}

/**
 * Percentile -> Citation Quartile. Stored as 'Q1'…'Q4'; displayed as C-Q1…C-Q4.
 *   >= 75 Q1, >= 50 Q2, >= 25 Q3, else Q4
 */
export function calculateCitationQuartile(percentile) {
  if (!isFiniteNumber(percentile)) return null
  if (percentile >= 75) return 'Q1'
  if (percentile >= 50) return 'Q2'
  if (percentile >= 25) return 'Q3'
  return 'Q4'
}

/**
 * Percentile -> POSI Zone (counted from the top of the ranking).
 *   >= 95 Zone 1 (top 5%), >= 80 Zone 2 (top 5–20%), >= 50 Zone 3 (top 20–50%), else Zone 4 (lower 50%)
 */
export function calculatePOSIZone(percentile) {
  if (!isFiniteNumber(percentile)) return null
  if (percentile >= 95) return 1
  if (percentile >= 80) return 2
  if (percentile >= 50) return 3
  return 4
}

/**
 * Ranks values descending with shared ties. Every member of a tied group
 * gets the same competition rank (1, 2, 2, 4), mid-rank, percentile,
 * quartile and zone. Nothing but the value decides order among journals —
 * never the title, ISSN or id.
 * @param {{ id: string, value: number }[]} entries
 * @returns {Map<string, { rank: number, rank_mid: number, percentile: number, quartile: string, zone: number, tied_with: string[] }>}
 */
export function rankWithTies(entries) {
  const n = entries.length
  const sorted = [...entries].sort((a, b) => b.value - a.value)
  const out = new Map()
  let i = 0
  while (i < n) {
    let j = i
    while (j < n && Math.abs(sorted[j].value - sorted[i].value) <= TIE_EPSILON) j++
    const rStart = i + 1
    const rEnd = j
    const rMid = calculateMidRank(rStart, rEnd)
    const percentile = calculatePercentile(rMid, n)
    const ids = sorted.slice(i, j).map(e => e.id)
    for (const id of ids) {
      out.set(id, {
        rank: rStart,
        rank_mid: rMid,
        percentile,
        quartile: calculateCitationQuartile(percentile),
        zone: calculatePOSIZone(percentile),
        tied_with: ids.filter(x => x !== id),
      })
    }
    i = j
  }
  return out
}

// ---------------------------------------------------------------------------
// Minimum data requirements and ranking status
// ---------------------------------------------------------------------------

export const RANKING_THRESHOLDS = Object.freeze({
  officialItems: 20,
  provisionalItems: 10,
  officialPublicationYears: 2,
  minCoverage: 0.9,
  categoryOfficialZone: 50,
  categoryProvisionalZone: 30,
  categoryQuartile: 20,
})

export const CITATION_RANKING_STATUS = Object.freeze([
  'official', 'provisional', 'insufficient_items', 'insufficient_category',
  'incomplete_coverage', 'observation', 'not_available',
])

/**
 * Journal-level eligibility for the citation ranking cohort (before the
 * category-size rule). Returns the status the journal would have if its
 * category were large enough.
 * @param {{ pnci?: number|null, eligibleItems?: number|null, publicationYears?: number|null,
 *           coverage?: number|null, lifecycleStage?: string|null, hasCategory?: boolean }} j
 */
export function getJournalRankingEligibility(j) {
  const items = j.eligibleItems ?? 0
  if (!isFiniteNumber(j.pnci) && items === 0) {
    return { status: j.lifecycleStage === 'observation' ? 'observation' : 'not_available', reason: 'no_eligible_items' }
  }
  if (!isFiniteNumber(j.coverage) || j.coverage < RANKING_THRESHOLDS.minCoverage) {
    return { status: 'incomplete_coverage', reason: 'citation_coverage_below_90' }
  }
  if (items < RANKING_THRESHOLDS.provisionalItems) {
    return { status: j.lifecycleStage === 'observation' ? 'observation' : 'insufficient_items', reason: 'fewer_than_10_items' }
  }
  if (!isFiniteNumber(j.pnci)) return { status: 'not_available', reason: 'no_pnci' }
  if (j.hasCategory === false) return { status: 'not_available', reason: 'no_rankable_category' }
  if (items < RANKING_THRESHOLDS.officialItems) return { status: 'provisional', reason: 'fewer_than_20_items' }
  if ((j.publicationYears ?? 0) < RANKING_THRESHOLDS.officialPublicationYears) return { status: 'provisional', reason: 'fewer_than_2_publication_years' }
  return { status: 'official', reason: null }
}

/**
 * The single ranking-status rule. Combines journal-level eligibility with
 * the size N of the journal's PSC category cohort.
 * @param {Parameters<typeof getJournalRankingEligibility>[0] & { categorySize?: number|null }} j
 * @returns {{ status: string, reason: string|null }}
 */
export function getCitationRankingStatus(j) {
  const base = getJournalRankingEligibility(j)
  if (base.status !== 'official' && base.status !== 'provisional') return base
  if (!isFiniteNumber(j.categorySize) || j.categorySize < RANKING_THRESHOLDS.categoryQuartile) {
    return { status: 'insufficient_category', reason: 'category_below_20' }
  }
  return base
}

/**
 * What a ranked journal may publish, given its status and its category size N.
 *   N >= 50  rank, percentile, quartile, official zone
 *   30–49    rank, percentile, quartile, provisional zone
 *   20–29    rank, percentile, quartile, no zone
 *   < 20     none (insufficient_category)
 * A provisional journal (10–19 items, or fewer than 2 publication years)
 * publishes a provisional rank, percentile and quartile, and no zone.
 * @returns {{ rank: boolean, quartile: boolean, zone: 'official'|'provisional'|null }}
 */
export function getRankingOutputs(status, categorySize) {
  if (status !== 'official' && status !== 'provisional') return { rank: false, quartile: false, zone: null }
  if (!isFiniteNumber(categorySize) || categorySize < RANKING_THRESHOLDS.categoryQuartile) return { rank: false, quartile: false, zone: null }
  if (status === 'provisional') return { rank: true, quartile: true, zone: null }
  if (categorySize >= RANKING_THRESHOLDS.categoryOfficialZone) return { rank: true, quartile: true, zone: 'official' }
  if (categorySize >= RANKING_THRESHOLDS.categoryProvisionalZone) return { rank: true, quartile: true, zone: 'provisional' }
  return { rank: true, quartile: true, zone: null }
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x)
}
