/**
 * Crossref work `type` -> PJR-SPEC.md § 5 `document_type` mapping.
 * Companion to `openalex-document-type.mjs`, same shape and same disclosure
 * discipline, for PCS's data-acquisition script (PCS-1.0-SPEC.md § 4/§ 8),
 * which must normalize Crossref's raw `type` field into the identical
 * `document_type` taxonomy `pci.mjs`'s `isCitable()` expects before a work
 * is eligible for `calculatePcs()` — so a work's citability never depends
 * on which citation graph happened to describe it.
 *
 * KNOWN, DISCLOSED LIMITATION — verified against live Crossref data
 * 2026-08-14, not assumed from memory: Crossref's works-list route
 * (`/journals/{issn}/works`) does NOT expose a `subtype` select field (a
 * live query with `select=subtype` 400s with "select-not-available", the
 * response listing every valid select — `subtype` is not among them), and
 * in practice essentially all real journal content — research articles,
 * reviews, editorials, letters, corrections alike — is typed
 * `journal-article` with no further discrimination. Confirmed via the
 * `type-name` facet against three real journals of very different size:
 *   - Journal of the American Chemical Society (ISSN 0002-7863): 14,471
 *     works in the 2022-2025 window, all `Journal Article`.
 *   - Nature (ISSN 1476-4687): 444,110 works, all `Journal Article` except
 *     one `Journal`-typed container record.
 *   - GRHAS (ISSN 3052-539X, a real POSI Core Collection journal): 40
 *     `Journal Article` + 1 `Journal Issue`.
 * Unlike `openalex-document-type.mjs` (which at least separates OpenAlex's
 * `review` from `article`, and has distinct `editorial`/`letter`/`erratum`/
 * `retraction` types), Crossref's `type` axis gives this project no
 * machine-readable way to separate a genuine research article from an
 * editorial, letter, or correction notice filed under the same
 * `journal-article` type. This project's existing precedent
 * (`openalex-document-type.mjs`'s own header) explicitly rules out
 * per-article title-keyword heuristics ("a guess dressed up as data") to
 * paper over exactly this kind of gap — the same rule applies here: this
 * module does not attempt to guess. The practical consequence for PCS is
 * that `pcs_eligible_items` may include a small number of non-article
 * `journal-article`-typed records (editorials, letters, corrections) that a
 * Crossref-only signal cannot separate out — a real, disclosed data-quality
 * caveat, not a silent misclassification. See the PCS ETL audit for how
 * this is reported per run.
 *
 * `journal-issue` / `journal-volume` / `journal` (structural/container
 * records, not articles — also observed live, see above) and every other
 * Crossref type with no PJR-SPEC document_type analog map to `null`
 * (excluded), same convention as `openalex-document-type.mjs`'s
 * `OPENALEX_TYPES_EXCLUDED`.
 */

/** Crossref type -> PJR-SPEC document_type, for the one type with a direct,
 * verifiable analog. `journal-article` is mapped to `research-article`
 * (citable) rather than left unmapped, because that IS the correct label
 * for the overwhelming majority of what it covers — the header above
 * documents the disclosed minority-case imprecision this causes. */
export const CROSSREF_TYPE_TO_DOCUMENT_TYPE = {
  'journal-article': 'research-article',
}

/** Crossref types with no PJR-SPEC document_type analog at all — structural
 * container records (a journal/issue/volume itself, not an article),
 * non-journal content types (books, proceedings, datasets, reports,
 * standards, grants, dissertations, peer-review reports, preprints/
 * posted-content, component sub-records), or a catch-all `other`. None are
 * force-mapped onto one of the 11 named document_type values. */
export const CROSSREF_TYPES_EXCLUDED = new Set([
  'journal',
  'journal-issue',
  'journal-volume',
  'proceedings',
  'proceedings-article',
  'proceedings-series',
  'book',
  'book-chapter',
  'book-part',
  'book-section',
  'book-series',
  'book-set',
  'book-track',
  'edited-book',
  'monograph',
  'reference-book',
  'reference-entry',
  'dissertation',
  'dataset',
  'component',
  'grant',
  'peer-review',
  'posted-content',
  'report',
  'report-series',
  'report-component',
  'standard',
  'standard-series',
  'other',
])

/**
 * @param {string | null | undefined} crossrefType - a work's raw Crossref `type` field
 * @returns {string | null} a PJR-SPEC.md § 5 document_type value, or null if
 *   there is no analog (excluded types, or an unrecognized/future Crossref
 *   type — treated the same as excluded rather than guessed).
 */
export function mapCrossrefType(crossrefType) {
  if (crossrefType == null) return null
  return CROSSREF_TYPE_TO_DOCUMENT_TYPE[crossrefType] ?? null
}
