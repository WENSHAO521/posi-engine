/**
 * Supporting diagnostics — MQS, IRS, CVI. Implements the "POSI Journal
 * Evaluation & Ranking Framework 1.0" diagnostics section. All three are
 * explicitly diagnostic-only: none may ever be blended into AJR-E, AJR-M,
 * or any ranking/quartile computation. This module enforces that boundary
 * structurally — none of these functions import or are imported by
 * ajr-early-stage.mjs, ajr-mature.mjs, quartile-tracks.mjs, or ranking.mjs
 * (verified by test/diagnostics.test.mjs's dependency-boundary check).
 *
 * - MQS (Metadata Quality Score) — 100 * earned/applicable, ALWAYS out of
 *   100 (the framework calls out that this must be consistent — "not
 *   sometimes /25 sometimes /100").
 * - IRS (Indexing Readiness Score) — technical diagnostic (sitemap,
 *   robots, OAI-PMH, Schema.org, Google Scholar metadata, DOI resolution,
 *   stable pages), 0-100. Must never be blended into AJR-E/AJR-M as a
 *   duplicate of the metadata dimension — this module computes it
 *   completely independently of evidence-coverage.mjs's dimensionScore()
 *   on purpose, so it can never accidentally share a code path with an
 *   actual AJR score.
 * - CVI (Citation Visibility Index) — visibility of citation
 *   INFRASTRUCTURE (Crossref cited-by, OpenAlex, OpenCitations, reference
 *   deposit, citation-data attribution), NOT citation impact. Must never
 *   feed M-Q.
 *
 * Pure functions, no I/O.
 */

export const DIAGNOSTICS_METHODOLOGY_VERSION = 'DIAG-1.0'

function round2(n) { return Math.round(n * 100) / 100 }

/**
 * MQS = 100 * (earned / applicable). Always out of 100.
 * @param {{ id: string, weight: number, met: boolean }[]} items
 * @returns {number} 0 when there are no applicable items at all (nothing
 *   to compute — not a claim of "0% metadata quality").
 */
export function computeMqs(items) {
  if (!items || items.length === 0) return 0
  const applicable = items.reduce((s, i) => s + (i.weight ?? 0), 0)
  if (applicable === 0) return 0
  const earned = items.reduce((s, i) => s + (i.met ? (i.weight ?? 0) : 0), 0)
  return round2(100 * (earned / applicable))
}

/**
 * IRS — technical indexing-readiness diagnostic, 0-100. Deliberately a
 * flat equal-weight checklist over exactly the seven signals the
 * framework names (sitemap, robots, OAI-PMH, Schema.org, Google Scholar
 * metadata, DOI resolution, stable pages) — JUDGMENT CALL (flagged): the
 * framework does not specify per-signal weights, so equal weighting
 * (100/7 each) is used, documented so a reviewer can argue with it
 * specifically rather than an unstated default.
 * @param {{ sitemap: boolean, robots: boolean, oaiPmh: boolean, schemaOrg: boolean, googleScholarMetadata: boolean, doiResolution: boolean, stablePages: boolean }} signals
 * @returns {number} 0-100
 */
export function computeIrs(signals) {
  const keys = ['sitemap', 'robots', 'oaiPmh', 'schemaOrg', 'googleScholarMetadata', 'doiResolution', 'stablePages']
  const perSignal = 100 / keys.length
  const earned = keys.reduce((s, k) => s + (signals?.[k] ? perSignal : 0), 0)
  return round2(earned)
}

/**
 * CVI — visibility of citation INFRASTRUCTURE, not impact. A journal can
 * score high CVI (well-indexed by Crossref/OpenAlex/OpenCitations, clean
 * reference deposit) while having low actual citation impact (PCI), and
 * vice versa — the two are intentionally uncorrelated by construction
 * (this function has no PCI/citation-count input at all).
 * @param {{ crossrefCitedByPresent: boolean, openAlexPresent: boolean, openCitationsPresent: boolean, referenceDepositRate: number, citationDataAttributionPresent: boolean }} signals
 *   `referenceDepositRate` is a 0-1 fraction (share of the journal's own
 *   articles that deposit their reference lists), the only non-boolean
 *   signal — weighted proportionally rather than as a threshold pass/fail.
 * @returns {number} 0-100
 */
export function computeCvi(signals) {
  const booleanWeight = 20 // 4 boolean signals * 20 = 80
  const depositWeight = 20 // reference deposit RATE * 20
  let score = 0
  if (signals?.crossrefCitedByPresent) score += booleanWeight
  if (signals?.openAlexPresent) score += booleanWeight
  if (signals?.openCitationsPresent) score += booleanWeight
  if (signals?.citationDataAttributionPresent) score += booleanWeight
  const depositRate = Math.max(0, Math.min(signals?.referenceDepositRate ?? 0, 1))
  score += depositWeight * depositRate
  return round2(score)
}
