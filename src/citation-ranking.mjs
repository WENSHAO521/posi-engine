/**
 * POSI Citation Ranking (CITATION-RANK-1.0, posi-data/POSI-EVAL-1.0-SPEC.md
 * § 5–13). Ranks journals by PNCI within their primary PSC category and
 * assigns rank, mid-rank percentile, Citation Quartile and POSI Zone, under
 * the minimum-data, coverage and category-size rules of evaluation.mjs.
 *
 * PCS and PCI are carried through as descriptive fields only: neither ever
 * enters the order, the percentile, the quartile or the zone. Total citations
 * are descriptive too — the order is PNCI, an item-level mean.
 *
 * Pure function, no I/O.
 */
import {
  getJournalRankingEligibility, getCitationRankingStatus, getRankingOutputs, rankWithTies,
  EVALUATION_VERSION, CITATION_RANK_VERSION, ZONES_VERSION, RANKING_THRESHOLDS,
} from './evaluation.mjs'
import { isRankEligiblePscConfidence } from './psc-classify.mjs'

/**
 * @param {{
 *   journal_id: string,
 *   pnci: number|null, pnci_model_version?: string, normalization?: string|null,
 *   eligible_items: number|null, publication_years?: number[], coverage: number|null,
 *   median_normalized_citation?: number|null, top10_share?: number|null, total_citations?: number|null,
 *   pcs?: number|null, pcs_methodology_version?: string|null, pci?: number|null,
 *   psc_category: string|null, psc_confidence: string|null, lifecycle_stage?: string|null,
 * }[]} entries
 * @param {{ metric_year: number, snapshot_date: string, categoryNames?: Record<string, string> }} context
 * @returns {object[]} one record per input journal, input order
 */
export function rankCitationEdition(entries, { metric_year, snapshot_date, categoryNames = {} }) {
  const prepared = entries.map(e => {
    const category = e.psc_confidence === 'multidisciplinary' ? null : (e.psc_category ?? null)
    const rankableCategory = !!category && isRankEligiblePscConfidence(e.psc_confidence)
    const input = {
      pnci: e.pnci,
      eligibleItems: e.eligible_items ?? 0,
      publicationYears: e.publication_years?.length ?? 0,
      coverage: e.coverage,
      lifecycleStage: e.lifecycle_stage ?? null,
      hasCategory: rankableCategory,
    }
    return { e, category, rankableCategory, input, eligibility: getJournalRankingEligibility(input) }
  })

  // Cohort: official and provisional journals of each rank-eligible category.
  const cohorts = new Map()
  for (const p of prepared) {
    if (!p.rankableCategory) continue
    if (p.eligibility.status !== 'official' && p.eligibility.status !== 'provisional') continue
    if (!cohorts.has(p.category)) cohorts.set(p.category, [])
    cohorts.get(p.category).push(p)
  }
  const ranks = new Map()
  for (const [, members] of cohorts) {
    if (members.length < RANKING_THRESHOLDS.categoryQuartile) continue
    for (const [id, r] of rankWithTies(members.map(p => ({ id: p.e.journal_id, value: p.e.pnci })))) ranks.set(id, r)
  }

  return prepared.map(p => {
    const { e, category } = p
    const cohortSize = p.rankableCategory ? (cohorts.get(category)?.length ?? 0) : null
    const inCohort = p.rankableCategory && (p.eligibility.status === 'official' || p.eligibility.status === 'provisional')
    const { status, reason } = inCohort
      ? getCitationRankingStatus({ ...p.input, categorySize: cohortSize })
      : p.eligibility
    const outputs = getRankingOutputs(status, cohortSize)
    const r = ranks.get(e.journal_id)
    return {
      journal_id: e.journal_id,
      metric_year,
      pnci: e.pnci ?? null,
      pnci_model_version: e.pnci_model_version ?? null,
      pnci_normalization: e.normalization ?? null,
      eligible_citable_items: e.eligible_items ?? null,
      publication_years: e.publication_years ?? [],
      citation_coverage: e.coverage ?? null,
      median_normalized_citation: e.median_normalized_citation ?? null,
      top10_share: e.top10_share ?? null,
      total_citations: e.total_citations ?? null,
      pci: e.pci ?? null,
      pcs: e.pcs ?? null,
      pcs_methodology_version: e.pcs_methodology_version ?? null,
      lifecycle_stage: e.lifecycle_stage ?? null,
      ranking_category_id: category,
      ranking_category_name: category ? categoryNames[category] ?? null : null,
      category_cohort_size: cohortSize,
      citation_rank: outputs.rank && r ? r.rank : null,
      citation_rank_mid: outputs.rank && r ? r.rank_mid : null,
      citation_rank_total: outputs.rank && r ? cohortSize : null,
      citation_percentile: outputs.rank && r ? r.percentile : null,
      citation_quartile: outputs.quartile && r ? r.quartile : null,
      posi_zone: outputs.zone && r ? r.zone : null,
      zone_status: outputs.zone && r ? outputs.zone : 'not_assigned',
      citation_ranking_status: status,
      ranking_status_reason: reason,
      tied_with: outputs.rank && r ? r.tied_with : [],
      ranking_snapshot_date: snapshot_date,
      ranking_methodology_version: CITATION_RANK_VERSION,
      zones_version: ZONES_VERSION,
      evaluation_version: EVALUATION_VERSION,
    }
  })
}
