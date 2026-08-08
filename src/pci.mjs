/**
 * PCI / PCI-5 / PNCI calculator — implements posi-data/PJR-SPEC.md § 5–6.
 *
 * STUB. Waiting on the first posi-data journal/work/citation migration
 * before there's real input to score against. Signatures below are the
 * intended contract; do not change PJR-SPEC.md § 5's citable-items table or
 * § 6's formulas without a methodology_version bump in the same PR.
 */

export const PCI_METHODOLOGY_VERSION = 'PCI-1.0'

export const CITABLE_DOCUMENT_TYPES = new Set([
  'research-article',
  'review-article',
  'systematic-review',
  'meta-analysis',
  'data-article',
])

/**
 * @param {{ document_type: string, retracted: boolean }} work
 * @returns {boolean} whether `work` counts toward a PCI denominator
 */
export function isCitable(work) {
  return CITABLE_DOCUMENT_TYPES.has(work.document_type) && !work.retracted
}

/**
 * @param {object[]} works - a journal's works published in the PCI window (Y-1, Y-2 for
 *   2-year PCI; Y-1..Y-5 for PCI-5), each with { document_type, retracted, citations_in_year }
 *   where citations_in_year excludes citations to/from retracted content (PJR-SPEC.md § 7).
 * @returns {{ ratio: number | null, citable_items: number, citation_count: number }}
 */
export function calculatePci(works) {
  const citable = works.filter(isCitable)
  const citable_items = citable.length
  const citation_count = citable.reduce((sum, w) => sum + (w.citations_in_year ?? 0), 0)
  return {
    ratio: citable_items > 0 ? citation_count / citable_items : null,
    citable_items,
    citation_count,
  }
}

/**
 * @param {number} journalRatio - this journal's PCI for metric_year
 * @param {number} categoryExpectedRatio - the primary PSC category's expected/average
 *   citation rate for the same metric_year (computed across all metric-eligible
 *   journals in that category — TODO: implement the category-average aggregation
 *   this depends on once real category-level data exists).
 * @returns {number | null}
 */
export function calculatePnci(journalRatio, categoryExpectedRatio) {
  if (journalRatio == null || !categoryExpectedRatio) return null
  return journalRatio / categoryExpectedRatio
}

// TODO(posi-data migration): calculatePci5(worksAcrossFiveYears)
// TODO: category-average aggregation feeding calculatePnci's second argument
