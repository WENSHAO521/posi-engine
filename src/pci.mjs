/**
 * PCI / PCI-5 / PNCI calculator — implements posi-data/PJR-SPEC.md § 5–6.
 * Do not change PJR-SPEC.md § 5's citable-items table or § 6's formulas
 * without a methodology_version bump in the same PR.
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
 * @param {{ document_type: string }} work
 * @returns {boolean} whether `work` counts toward a PCI denominator
 *
 * Retraction status is deliberately NOT checked here — PJR-SPEC.md § 7 is
 * explicit that a retracted work stays in the denominator if it was citable
 * when published (removing it would shrink the denominator and perversely
 * raise the journal's PCI). Retraction instead affects the NUMERATOR: the
 * caller is responsible for computing each work's `citations_in_year` with
 * citations to/from retracted content already excluded before it reaches
 * calculatePci() — see that function's parameter doc.
 */
export function isCitable(work) {
  return CITABLE_DOCUMENT_TYPES.has(work.document_type)
}

/**
 * @param {object[]} works - a journal's works published in the PCI window (Y-1, Y-2 for
 *   2-year PCI; Y-1..Y-5 for PCI-5), each with { document_type, citations_in_year }
 *   where citations_in_year has ALREADY had citations to/from retracted content
 *   excluded by the caller (PJR-SPEC.md § 7) — retracted works themselves are
 *   still passed in and still counted via isCitable() above.
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
 * PCI-5 — same formula and citable-items rules as calculatePci(), over a
 * 5-year publication window (Y-1 through Y-5) instead of 2 (PJR-SPEC.md
 * § 6). There is nothing mathematically different about the 5-year window
 * — this is a separate export (rather than callers just calling
 * calculatePci() again) so the window itself is decided in exactly one
 * place per call site, not re-derived ad hoc, and so a future change to
 * PCI-5's formula (independent of PCI's) has somewhere to land without an
 * ambiguous shared function name.
 * @param {object[]} works - a journal's works published in the 5-year PCI-5
 *   window (Y-1..Y-5), same shape/retraction-handling contract as calculatePci().
 * @returns {{ ratio: number | null, citable_items: number, citation_count: number }}
 */
export function calculatePci5(works) {
  return calculatePci(works)
}

/**
 * The "expected citation rate" a category's PNCI values are normalized
 * against (PJR-SPEC.md § 6). Computed as a POOLED rate — total citations
 * across every metric-eligible journal in the category divided by total
 * citable items across the same set — not an unweighted mean of each
 * journal's own PCI. An unweighted mean of ratios lets a handful of
 * low-volume journals (small citable_items denominators, so a noisy PCI)
 * swing the category baseline as much as a high-volume flagship journal;
 * pooling first is the standard field-normalization approach (the same
 * shape as a journal-level PCI itself: total citations / total citable
 * items, just aggregated one level up) and keeps the baseline weighted by
 * actual publication volume.
 * @param {{ citable_items: number, citation_count: number }[]} entries - one
 *   entry per metric-eligible journal in a single PSC category and
 *   metric_year (calculatePci()'s/calculatePci5()'s own return shape works
 *   directly as input here).
 * @returns {number | null} null if the category has no citable items at all
 *   (nothing to divide by — not the same as a 0.0 rate).
 */
export function calculateCategoryBaseline(entries) {
  const totalCitable = entries.reduce((sum, e) => sum + (e.citable_items ?? 0), 0)
  const totalCitations = entries.reduce((sum, e) => sum + (e.citation_count ?? 0), 0)
  return totalCitable > 0 ? totalCitations / totalCitable : null
}

/**
 * @param {number} journalRatio - this journal's PCI for metric_year
 * @param {number} categoryExpectedRatio - the primary PSC category's expected/average
 *   citation rate for the same metric_year — see calculateCategoryBaseline().
 * @returns {number | null}
 */
export function calculatePnci(journalRatio, categoryExpectedRatio) {
  if (journalRatio == null || !categoryExpectedRatio) return null
  return journalRatio / categoryExpectedRatio
}
