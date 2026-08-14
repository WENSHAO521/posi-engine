/**
 * PCS resolver — PCS's data-acquisition script's normalization stage
 * (PCS-1.0-SPEC.md § 8). Pure functions only, no I/O (see
 * `works-fetch.mjs`/`PCS_SELECT_FIELDS` for the fetch layer this
 * consumes, `crossref-document-type.mjs` for the type crosswalk this
 * calls). Turns a raw Crossref work-list item into the exact shape
 * `calculatePcs()` (`pcs.mjs`) requires:
 *   `{ document_type, is_referenced_by_count }`.
 *
 * Reuses `works-resolver.mjs#crossrefDateToIso()` for date parsing rather
 * than re-implementing Crossref's date-parts shape a second time.
 */

import { crossrefDateToIso } from './works-resolver.mjs'
import { mapCrossrefType } from './crossref-document-type.mjs'

export const PCS_RESOLVER_METHODOLOGY_VERSION = 'PCS-RESOLVER-1.0'

/**
 * @param {object} raw - one Crossref work-list item, PCS_SELECT_FIELDS shape
 *   ({ DOI, type, 'is-referenced-by-count', published, issued })
 * @returns {{
 *   doi: string|null, document_type: string|null,
 *   is_referenced_by_count: number|null, published_year: number|null,
 * }}
 *   `is_referenced_by_count` is left as Crossref actually reported it —
 *   `null` when the field was entirely absent (PCS-1.0-SPEC.md § 7's
 *   distinction between "absent" and "reported as 0" is preserved here,
 *   not collapsed; `calculatePcs()` is the one place that defaults an
 *   absent count to 0 for the numerator while still tracking
 *   `items_with_citation_data` separately).
 */
export function normalizeCrossrefWorkForPcs(raw) {
  const publishedIso = crossrefDateToIso(raw.published) ?? crossrefDateToIso(raw.issued)
  const published_year = publishedIso ? Number(publishedIso.slice(0, 4)) : null
  const rawCount = raw['is-referenced-by-count']
  return {
    doi: raw.DOI ?? null,
    document_type: mapCrossrefType(raw.type),
    is_referenced_by_count: typeof rawCount === 'number' ? rawCount : null,
    published_year,
  }
}

/**
 * Defensive, client-side re-check of PCS-1.0-SPEC.md § 5's 4-year
 * publication window — Crossref's own `from-pub-date`/`until-pub-date`
 * filter (used at fetch time, see `run-pcs-etl.mjs`) is the primary
 * enforcement, but Crossref's date filter is documented to match against
 * WHICHEVER date type a record carries (print, online, or a generic
 * `issued` date), so a record can in principle surface with a normalized
 * `published_year` just outside the requested window. Filtering again here
 * on the resolver's own parsed year, rather than trusting the server-side
 * filter blindly, keeps the window's meaning exact rather than "whatever
 * Crossref's filter happened to match" — see the PCS ETL audit for how
 * many records (if any) this excludes per run.
 * @param {{ published_year: number|null }} work
 * @param {number} startYear - PCS-1.0-SPEC.md § 5's Y-4
 * @param {number} endYear - PCS-1.0-SPEC.md § 5's Y-1
 * @returns {boolean}
 */
export function isInPcsWindow(work, startYear, endYear) {
  return work.published_year != null && work.published_year >= startYear && work.published_year <= endYear
}

/**
 * PCS-1.0-SPEC.md § 5's window for a given metric_year Y: the 4 complete
 * publication years Y-4 through Y-1 (Y itself excluded — not yet complete).
 * @param {number} metricYear
 * @returns {{ startYear: number, endYear: number }}
 */
export function pcsWindowForMetricYear(metricYear) {
  return { startYear: metricYear - 4, endYear: metricYear - 1 }
}
