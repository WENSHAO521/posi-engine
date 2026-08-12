/**
 * PCS (POSI Citation Score) calculator — implements posi-data/PCS-1.0-SPEC.md.
 * A Crossref-based 4-year citation-performance indicator, deliberately
 * independent of the PCI/PCI-5/PNCI family (see pci.mjs): never averaged,
 * blended, or used to correct/be corrected by PCI, never enters Citation Q
 * or AJR-M's citation component (PCS-1.0-SPEC.md § 1).
 *
 * This module is a pure calculator, same shape as pci.mjs — it does not
 * call the Crossref API. The caller is responsible for cursor-paginating
 * Crossref, resolving the 4-complete-publication-year window
 * (PCS-1.0-SPEC.md § 5), and normalizing each work's Crossref `type` into
 * the same `document_type` taxonomy pci.mjs's isCitable() expects
 * (PCS-1.0-SPEC.md § 4) before calling calculatePcs().
 */

import { isCitable } from './pci.mjs'

export const PCS_METHODOLOGY_VERSION = 'PCS-1.0'

/**
 * @param {object[]} works - eligible works actually fetched from Crossref
 *   (PCS-1.0-SPEC.md § 5's 4-year window), each with
 *   { document_type, is_referenced_by_count }. A work with no
 *   is_referenced_by_count (or `0`) is a real data point — Crossref
 *   tracks 0 as a valid count — and is included at 0, not excluded
 *   (PCS-1.0-SPEC.md § 7). A work that could not be fetched at all must
 *   not appear in this array in the first place; see calculatePcsCoverage()
 *   for tracking that separately.
 * @returns {{ pcs: number | null, eligible_items: number, citation_count: number, items_with_citation_data: number }}
 *   `items_with_citation_data` is distinct from `eligible_items`: it counts
 *   only works where Crossref actually returned an is_referenced_by_count
 *   field (including an explicit `0`), separate from works that were
 *   fetched but had the field entirely absent and were defaulted to 0 —
 *   so a reader can tell "111 of 120 eligible items had real Crossref
 *   citation data" apart from "120 eligible items, PCS computed."
 */
export function calculatePcs(works) {
  const citable = works.filter(isCitable)
  const eligible_items = citable.length
  const citation_count = citable.reduce((sum, w) => sum + (w.is_referenced_by_count ?? 0), 0)
  const items_with_citation_data = citable.filter(w => w.is_referenced_by_count != null).length
  return {
    pcs: eligible_items > 0 ? citation_count / eligible_items : null,
    eligible_items,
    citation_count,
    items_with_citation_data,
  }
}

/**
 * PCS-1.0-SPEC.md § 9's `pcs_coverage` — the fraction of enumerated
 * eligible DOIs that were successfully fetched from Crossref, independent
 * of document-type filtering (a successfully-fetched-but-non-citable work
 * is not a coverage problem; a work that failed to fetch is). Kept as a
 * separate helper rather than folded into calculatePcs() because it needs
 * the pre-fetch enumerated-DOI count, which calculatePcs() never sees
 * (it only receives works that were actually fetched).
 * @param {number} fetchedCount - DOIs successfully fetched from Crossref.
 * @param {number} enumeratedCount - total DOIs identified as in-window,
 *   before any fetch attempt.
 * @returns {number | null} null if there was nothing to enumerate at all
 *   (not the same as a 0% coverage result).
 */
export function calculatePcsCoverage(fetchedCount, enumeratedCount) {
  if (!enumeratedCount) return null
  return fetchedCount / enumeratedCount
}
