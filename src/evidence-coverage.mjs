/**
 * Evidence Coverage — implements the "POSI Journal Evaluation & Ranking
 * Framework 1.0" Evidence Coverage section. This is the shared normalizer
 * AJR-E (ajr-early-stage.mjs) and AJR-M (ajr-mature.mjs) both build their
 * per-dimension scores on top of, plus the standalone eligibility gate
 * (Official / Provisional / Not Rateable) that decides whether a score is
 * shown at all.
 *
 * Pure functions only: given a list of already-evaluated evidence items
 * (this module does no crawling/fetching — resolving each item's status is
 * the caller's responsibility, e.g. a site-crawl step upstream), compute
 * the Evidence Coverage percentage and a dimension's normalized score.
 *
 * Per-item status is one of seven values — never a binary found/not-found
 * (framework's explicit requirement):
 *   Met | Not Met | Unknown | Blocked | Not Applicable | Conflicted | Stale
 *
 * Weight normalization rule (framework, verbatim):
 *   DimensionScore = DimensionWeight * (MetEvidenceWeight / ResolvedApplicableEvidenceWeight)
 * i.e. normalize against what was actually RESOLVED (Met+NotMet only), not
 * against total applicable including Unknown/Blocked/Conflicted/Stale — an
 * item POSI genuinely could not check (e.g. a publisher site returned HTTP
 * 403) must not silently count as failed. "Not Applicable" items are
 * removed from the applicable-weight denominator entirely (they don't
 * count as unresolved OR as failed — they simply don't apply to this
 * journal), per the framework's Transparency-dimension note.
 */

export const EVIDENCE_COVERAGE_METHODOLOGY_VERSION = 'EC-1.0'

export const EVIDENCE_STATUSES = Object.freeze([
  'met',
  'not_met',
  'unknown',
  'blocked',
  'not_applicable',
  'conflicted',
  'stale',
])

/** Statuses that count toward the "resolved" weight — i.e. POSI actually
 * got a definitive yes/no answer, whether or not the journal met the bar.
 * Everything else (unknown/blocked/conflicted/stale) is applicable but
 * NOT resolved — the item counts against Evidence Coverage but never
 * silently as a failing score. */
const RESOLVED_STATUSES = new Set(['met', 'not_met'])

export const EC_OFFICIAL_THRESHOLD = 80
export const EC_PROVISIONAL_THRESHOLD = 60

/**
 * Maps a raw HTTP status / fetch outcome to a distinct reason string, so a
 * 403 (bot-blocked), a 404 (page genuinely gone), a 429 (rate-limited —
 * retry, not a verdict), a timeout, and a generic network error are never
 * collapsed into one undifferentiated "not found" (framework's explicit
 * requirement). Does not decide the evidence status itself — see
 * classifyFetchOutcome() for the status this reason typically implies.
 * @param {number|string|null} outcome - an HTTP status code, or one of
 *   'timeout' | 'network_error'
 * @returns {string} a stable, human-readable reason code
 */
export function describeFetchFailureReason(outcome) {
  if (outcome === 'timeout') return 'timeout'
  if (outcome === 'network_error') return 'network_error'
  if (outcome === 403) return 'http_403_forbidden'
  if (outcome === 404) return 'http_404_not_found'
  if (outcome === 429) return 'http_429_rate_limited'
  if (typeof outcome === 'number' && outcome >= 500) return `http_${outcome}_server_error`
  if (typeof outcome === 'number' && outcome >= 400) return `http_${outcome}_client_error`
  if (outcome == null) return 'no_response'
  return `http_${outcome}`
}

/**
 * A fetch failure is evidence POSI could not resolve, not evidence the
 * item failed — this maps a failure reason to the correct `unknown`/
 * `blocked` status split (framework § "Unknown must NOT default to a 0/
 * failing score" + AJR-SPEC.md § 7's blocked-vs-insufficient_evidence
 * distinction). 403/429 read as active blocking (`blocked`); 404/timeout/
 * network error/5xx read as `unknown` (POSI's crawl simply didn't get a
 * usable answer, not necessarily deliberate blocking).
 * @param {number|string|null} outcome
 * @returns {'blocked'|'unknown'}
 */
export function classifyFetchOutcomeStatus(outcome) {
  if (outcome === 403 || outcome === 429) return 'blocked'
  return 'unknown'
}

/**
 * @param {{ id: string, weight: number, status: string }[]} items
 * @returns {{ coverage_percent: number, applicable_weight: number, resolved_weight: number, met_weight: number, not_applicable_weight: number }}
 */
export function evidenceCoverage(items) {
  assertValidStatuses(items)
  const applicable = items.filter(i => i.status !== 'not_applicable')
  const applicableWeight = sumWeight(applicable)
  const resolved = applicable.filter(i => RESOLVED_STATUSES.has(i.status))
  const resolvedWeight = sumWeight(resolved)
  const metWeight = sumWeight(applicable.filter(i => i.status === 'met'))
  const notApplicableWeight = sumWeight(items.filter(i => i.status === 'not_applicable'))
  const coveragePercent = applicableWeight > 0 ? (resolvedWeight / applicableWeight) * 100 : 0
  return {
    coverage_percent: round2(coveragePercent),
    applicable_weight: applicableWeight,
    resolved_weight: resolvedWeight,
    met_weight: metWeight,
    not_applicable_weight: notApplicableWeight,
  }
}

/**
 * DimensionScore = DimensionWeight * (MetEvidenceWeight / ResolvedApplicableEvidenceWeight)
 * @param {{ id: string, weight: number, status: string }[]} items - the
 *   evidence items belonging to ONE scoring dimension (e.g. AJR-E's
 *   Editorial Governance & Peer Review, weight 15).
 * @param {number} dimensionWeight - the dimension's total point value.
 * @returns {{ score: number, coverage: ReturnType<typeof evidenceCoverage> }}
 *   `score` is 0 (not a penalty, just uncomputable) when
 *   resolved_weight is 0 (nothing in this dimension was ever resolved —
 *   the caller should treat this as "insufficient evidence for this
 *   dimension", not "this dimension scored zero on the merits").
 */
export function dimensionScore(items, dimensionWeight) {
  const coverage = evidenceCoverage(items)
  const score = coverage.resolved_weight > 0
    ? dimensionWeight * (coverage.met_weight / coverage.resolved_weight)
    : 0
  return { score: round2(score), coverage }
}

/**
 * @param {number} coveragePercent
 * @param {boolean} mandatoryEvidenceResolved - true only if EVERY mandatory
 *   evidence item (journal identity, ISSN, launch date, lifecycle, article
 *   sample, PSC, no unresolved severe integrity finding) is resolved,
 *   regardless of the overall EC%.
 * @returns {'official'|'provisional'|'not_rateable'}
 */
export function ratingEligibility(coveragePercent, mandatoryEvidenceResolved) {
  if (!mandatoryEvidenceResolved) return 'not_rateable'
  if (coveragePercent >= EC_OFFICIAL_THRESHOLD) return 'official'
  if (coveragePercent >= EC_PROVISIONAL_THRESHOLD) return 'provisional'
  return 'not_rateable'
}

function sumWeight(items) {
  return items.reduce((s, i) => s + (i.weight ?? 0), 0)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function assertValidStatuses(items) {
  for (const item of items) {
    if (!EVIDENCE_STATUSES.includes(item.status)) {
      throw new Error(`evidence-coverage: invalid status "${item.status}" for item "${item.id}" — must be one of ${EVIDENCE_STATUSES.join(', ')}`)
    }
  }
}
