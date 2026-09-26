/**
 * PCS-Q — the PCS Quartile track. Implements posi-data/PCS-Q-1.0-SPEC.md.
 *
 * A fourth quartile track alongside E-Q, M-Q and Citation Q, with the same
 * RANK-1.0 midrank/percentile/quartile algorithm (quartile-tracks.mjs's
 * percentileMidrank(), shared, not copied) and PCS (PCS-1.0-SPEC.md) as the
 * input score. It ranks every indexed journal with sufficient PCS data —
 * Core Collection and non-Core alike — which is what makes it the platform's
 * open, all-journal ranking. It never feeds Citation Q, E-Q or M-Q, and they
 * never feed it.
 *
 * Eligibility (PCS-Q-1.0-SPEC.md § 3), each rule reported per journal:
 *   - pcs is a number (not null)
 *   - pcs_eligible_items >= PCS_Q_MIN_ITEMS
 *   - pcs_coverage >= PCS_Q_MIN_COVERAGE (fetch completeness, PCS-1.0 § 9)
 * Category ranking additionally needs a primary PSC category whose
 * confidence is rank-eligible (psc-classify.mjs isRankEligiblePscConfidence:
 * high/verified), and a category of at least MIN_CATEGORY_SIZE eligible
 * journals (PJR-SPEC.md § 8, flat, no fallback — same as Citation Q).
 * Every eligible journal also receives an all-category ("overall") rank.
 *
 * Pure functions, no I/O.
 */
import { percentileMidrank, quartileLabel, MIN_CATEGORY_SIZE } from './quartile-tracks.mjs'
import { isRankEligiblePscConfidence } from './psc-classify.mjs'

export const PCS_Q_METHODOLOGY_VERSION = 'PCS-Q-1.0'
export const PCS_Q_MIN_ITEMS = 5
export const PCS_Q_MIN_COVERAGE = 0.9

/**
 * @param {{ pcs: number|null, pcs_eligible_items: number|null, pcs_coverage: number|null }} e
 * @returns {{ eligible: boolean, reason: string|null }}
 */
export function pcsQEligibility(e) {
  if (typeof e.pcs !== 'number' || Number.isNaN(e.pcs)) return { eligible: false, reason: 'no_pcs' }
  if ((e.pcs_eligible_items ?? 0) < PCS_Q_MIN_ITEMS) return { eligible: false, reason: 'too_few_items' }
  if (e.pcs_coverage == null || e.pcs_coverage < PCS_Q_MIN_COVERAGE) return { eligible: false, reason: 'incomplete_fetch' }
  return { eligible: true, reason: null }
}

/**
 * @param {{ journal_id: string, pcs: number|null, pcs_eligible_items: number|null, pcs_coverage: number|null,
 *           psc_category: string|null, psc_confidence: string|null }[]} entries
 * @param {{ metric_year: number }} context
 * @returns {object[]} one record per input journal
 */
export function rankPcsTrack(entries, { metric_year }) {
  const eligible = []
  const out = new Map()

  for (const e of entries) {
    const { eligible: ok, reason } = pcsQEligibility(e)
    const base = {
      journal_id: e.journal_id,
      track: 'pcs',
      metric_year,
      pcs: e.pcs ?? null,
      pcs_eligible_items: e.pcs_eligible_items ?? null,
      category_code: e.psc_category ?? null,
      rank: null, rank_mid: null, category_size: null, percentile: null, quartile: null, quartile_label: null,
      overall_rank: null, overall_size: null, overall_percentile: null, overall_quartile: null,
      ranking_method: 'unavailable',
      exclusion_reason: reason,
      tied_with: [],
      methodology_version: PCS_Q_METHODOLOGY_VERSION,
    }
    out.set(e.journal_id, base)
    if (ok) eligible.push(e)
  }

  // Overall: every eligible journal, one universe.
  for (const r of percentileMidrank(eligible.map(e => ({ id: e.journal_id, value: e.pcs })))) {
    Object.assign(out.get(r.id), {
      overall_rank: r.rank,
      overall_size: eligible.length,
      overall_percentile: r.percentile,
      overall_quartile: r.quartile,
    })
  }

  // Category: primary PSC, rank-eligible confidence, N >= MIN_CATEGORY_SIZE.
  const byCategory = new Map()
  for (const e of eligible) {
    const rec = out.get(e.journal_id)
    if (!e.psc_category) { rec.exclusion_reason = 'no_psc_category'; continue }
    if (!isRankEligiblePscConfidence(e.psc_confidence)) { rec.exclusion_reason = 'psc_confidence_not_rank_eligible'; continue }
    byCategory.set(e.psc_category, [...(byCategory.get(e.psc_category) ?? []), e])
  }
  for (const [code, rows] of byCategory) {
    if (rows.length < MIN_CATEGORY_SIZE) {
      for (const e of rows) Object.assign(out.get(e.journal_id), { category_size: rows.length, exclusion_reason: 'category_below_min_size' })
      continue
    }
    for (const r of percentileMidrank(rows.map(e => ({ id: e.journal_id, value: e.pcs })))) {
      Object.assign(out.get(r.id), {
        category_code: code,
        rank: r.rank,
        rank_mid: r.rank_mid,
        category_size: rows.length,
        percentile: r.percentile,
        quartile: r.quartile,
        quartile_label: quartileLabel('pcs', r.quartile),
        ranking_method: 'pcs_midrank',
        exclusion_reason: null,
        tied_with: r.tied_with,
      })
    }
  }

  return entries.map(e => out.get(e.journal_id))
}

export { MIN_CATEGORY_SIZE }
