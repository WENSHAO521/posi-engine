/**
 * OpenAlex work `type` -> PJR-SPEC.md § 5 `document_type` mapping.
 *
 * OpenAlex's work-level `type` taxonomy (https://docs.openalex.org/api-entities/works/work-object#type)
 * is coarser and drawn on a different axis than PJR-SPEC's 11-value
 * document_type table — it doesn't distinguish "systematic-review" or
 * "meta-analysis" from a general "review", and it has several types
 * (dataset, peer-review, paratext, supplementary-materials, ...) with no
 * PJR-SPEC analog at all. This module documents an explicit, reviewable
 * decision for every OpenAlex type this project has actually observed,
 * rather than leaving the gap to be silently guessed at call sites.
 *
 * Decisions and why:
 * - `article`            -> research-article. The overwhelming majority of
 *   citable journal content; OpenAlex does not itself split out
 *   "systematic-review"/"meta-analysis" as distinct types, so per-article
 *   heuristics (title keyword matching) would be a guess dressed up as
 *   data — not attempted here. This means PJR-SPEC's systematic-review and
 *   meta-analysis rows are never populated by this mapping alone; both are
 *   citable either way, so PCI's denominator is unaffected, only the
 *   (currently unused — no work-level schema exists in posi-data yet)
 *   document_type label would differ.
 * - `review`              -> review-article (citable).
 * - `editorial`           -> editorial (not citable).
 * - `letter`               -> letter (not citable).
 * - `erratum`              -> correction (not citable). OpenAlex's naming
 *   ("erratum") differs from PJR-SPEC's ("correction") — same concept.
 * - `retraction`           -> retraction-notice (not citable). Separate from
 *   PJR-SPEC.md § 7's retraction-handling rules for the retracted work
 *   ITSELF (which keeps its own original type) — this is the notice
 *   document type, not the retracted article.
 * - `editorial-material` (used by some source records, e.g. Crossref-typed)
 *                          -> editorial (not citable).
 * - `paratext`             -> excluded. Front matter, indices, tables of
 *   contents — not a scholarly document in any PJR-SPEC sense; no citable
 *   analog and no "not citable but still a real article" analog either
 *   (unlike editorial/letter, which ARE real short-form content).
 * - `book-review`          -> book-review (not citable).
 * - `news`                 -> news (not citable).
 * - `dataset`              -> excluded. A `dataset`-typed OpenAlex work
 *   attached to a journal source is typically a deposited data object
 *   (e.g. mirrored from Dryad/Zenodo), not a journal-published
 *   data-descriptor ARTICLE — PJR-SPEC's `data-article` row means the
 *   latter. OpenAlex's `type` field alone gives no reliable signal for
 *   distinguishing a true data-descriptor article (which would in practice
 *   carry `type: "article"`) from an indexed raw dataset, so this mapping
 *   does not attempt to populate `data-article` at all — a known gap, not
 *   a silent misclassification.
 * - `peer-review`          -> excluded. Not a document type PJR-SPEC covers.
 * - `supplementary-materials`, `reference-entry`, `other`, `standard`,
 *   `report`, `grant`      -> excluded. None are citable journal content
 *   under PJR-SPEC § 5, and none map cleanly onto its non-citable rows
 *   either (they are not editorials, letters, corrections, retractions,
 *   news, book-reviews, or meeting-abstracts) — rather than force a
 *   best-guess label, these are excluded from the metric entirely, exactly
 *   like the true PJR-SPEC non-citable types.
 * - meeting-abstract: OpenAlex has no distinct top-level `type` for
 *   conference/meeting abstracts appearing in a journal (they are most
 *   often typed `article` upstream, indistinguishably from a full
 *   research article, or occasionally `other`). This mapping does not
 *   attempt to detect them from `type` alone — a known precision gap,
 *   documented rather than guessed. A future pass could use
 *   `is_paratext`/page-count/`type_crossref` heuristics if this proves to
 *   materially affect specific journals' PCI.
 */

/** OpenAlex type -> PJR-SPEC document_type, for types with a direct analog. */
export const OPENALEX_TYPE_TO_DOCUMENT_TYPE = {
  article: 'research-article',
  review: 'review-article',
  editorial: 'editorial',
  'editorial-material': 'editorial',
  letter: 'letter',
  erratum: 'correction',
  retraction: 'retraction-notice',
  'book-review': 'book-review',
  news: 'news',
}

/** OpenAlex types with NO PJR-SPEC analog at all — always not citable, but
 * deliberately not force-mapped onto one of the 11 named document_type
 * values (see module header). */
export const OPENALEX_TYPES_EXCLUDED = new Set([
  'paratext',
  'dataset',
  'peer-review',
  'supplementary-materials',
  'reference-entry',
  'standard',
  'report',
  'grant',
  'other',
]);

/**
 * @param {string | null | undefined} openalexType - a work's raw `type` field
 * @returns {string | null} a PJR-SPEC.md § 5 document_type value, or null if
 *   there is no analog (excluded types, or an unrecognized/future OpenAlex
 *   type — treated the same as excluded rather than guessed).
 */
export function mapOpenAlexType(openalexType) {
  if (openalexType == null) return null
  return OPENALEX_TYPE_TO_DOCUMENT_TYPE[openalexType] ?? null
}

/**
 * @param {string | null | undefined} openalexType
 * @returns {boolean} whether this OpenAlex type maps to a PJR-SPEC citable
 *   document_type. Unmapped/excluded types are never citable — this is the
 *   single function pipeline code should call rather than re-deriving the
 *   citability of a raw OpenAlex type ad hoc.
 */
export function isOpenAlexTypeCitable(openalexType) {
  const mapped = mapOpenAlexType(openalexType)
  return mapped === 'research-article' || mapped === 'review-article'
    || mapped === 'systematic-review' || mapped === 'meta-analysis' || mapped === 'data-article'
}
