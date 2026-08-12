/**
 * First Regular Scholarly Publication Date resolution — implements the
 * "POSI Journal Evaluation & Ranking Framework 1.0" lifecycle section's
 * resolution-priority rule. This is the age basis lifecycle.mjs consumes
 * (LIFECYCLE-1.1) — never ISSN registration date, website launch date, or
 * POSI coverage-start date.
 *
 * Pure function: given a set of already-fetched candidate evidence items
 * (this module does no I/O — fetching Crossref/OpenAlex/publisher records
 * is the caller's responsibility), pick the earliest date that qualifies
 * as a "regular scholarly publication" under the source-priority rule, and
 * return a persisted resolution record so the decision is computed once
 * and stored, not re-guessed on every pipeline run.
 *
 * Resolution priority (highest first):
 *   1. verified publisher/archive evidence  (source: 'publisher_verified' | 'archive_verified')
 *   2. earliest regular Crossref scholarly article (source: 'crossref')
 *   3. earliest regular OpenAlex scholarly work (source: 'openalex')
 *   4. other verifiable archive evidence (source: 'other_archive')
 *   5. unknown — no qualifying candidate
 *
 * Within a tied-priority source, the EARLIEST qualifying date wins (the
 * "first" publication, not just any publication from that source).
 *
 * Excluded from candidacy regardless of source (these are not "regular
 * scholarly publications"): editorial, call-for-papers, front matter,
 * correction, retraction notice, announcement. A candidate's `document_type`
 * (or, if absent, its `title`, as a last-resort heuristic — see
 * isLikelyNonRegularTitle()) is checked against this list.
 */

export const FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION = 'FPD-1.0'

/** Priority order, highest first. A candidate's `source` field must be one
 * of these; anything else is rejected rather than silently ranked last, so
 * a caller passing an unrecognized source finds out immediately. */
export const SOURCE_PRIORITY = [
  'publisher_verified',
  'archive_verified',
  'crossref',
  'openalex',
  'other_archive',
]

/** document_type values that are explicitly NOT a "regular scholarly
 * publication" — mirrors the framework's own exclusion list. Distinct from
 * (and a superset relevant to this check only, not to be confused with)
 * PJR-SPEC.md § 5's citable-items table, which is about the PCI
 * denominator, not journal age. */
export const NON_REGULAR_DOCUMENT_TYPES = new Set([
  'editorial',
  'call-for-papers',
  'front-matter',
  'correction',
  'retraction-notice',
  'announcement',
])

/** Last-resort, best-effort title heuristic used ONLY when a candidate has
 * no document_type at all (e.g. a sparse archive record) — matched
 * case-insensitively against common front-matter/announcement phrasing.
 * This is deliberately conservative (few, high-precision patterns) because
 * a false exclusion silently discards real evidence, which is worse here
 * than an occasional false inclusion a human can correct later. */
const NON_REGULAR_TITLE_PATTERNS = [
  /^editorial\b/i,
  /^call for papers\b/i,
  /^front matter\b/i,
  /^table of contents\b/i,
  /^corrigendum\b/i,
  /^erratum\b/i,
  /^retraction\b/i,
  /^announcement\b/i,
  /^issue information\b/i,
]

function isLikelyNonRegularTitle(title) {
  if (!title) return false
  return NON_REGULAR_TITLE_PATTERNS.some(re => re.test(title.trim()))
}

/**
 * @param {{ document_type?: string, title?: string }} candidate
 * @returns {boolean} true if this candidate is disqualified as "not a
 *   regular scholarly publication"
 */
export function isExcludedFromFirstPublicationCandidacy(candidate) {
  if (candidate.document_type && NON_REGULAR_DOCUMENT_TYPES.has(candidate.document_type)) return true
  if (!candidate.document_type && isLikelyNonRegularTitle(candidate.title)) return true
  return false
}

/**
 * @param {{
 *   source: 'publisher_verified'|'archive_verified'|'crossref'|'openalex'|'other_archive',
 *   date: string,                 // ISO date, e.g. '2024-03-18'
 *   evidence_id?: string|null,    // e.g. a DOI, an archive URL
 *   document_type?: string,
 *   title?: string,
 * }[]} candidates
 * @param {string} verifiedAtIso - ISO date this resolution was computed, e.g. '2026-08-12'
 * @returns {{
 *   first_regular_publication_date: string|null,
 *   source: string|null,
 *   evidence_id: string|null,
 *   verified_at: string,
 *   methodology_version: string,
 *   excluded_candidate_count: number,
 *   rejected_unrecognized_sources: string[],
 * }}
 */
export function resolveFirstPublicationDate(candidates, verifiedAtIso) {
  const rejectedUnrecognizedSources = []
  const eligible = []
  let excludedCount = 0

  for (const c of candidates ?? []) {
    if (!SOURCE_PRIORITY.includes(c.source)) {
      rejectedUnrecognizedSources.push(c.source)
      continue
    }
    if (!c.date) continue
    if (isExcludedFromFirstPublicationCandidacy(c)) {
      excludedCount++
      continue
    }
    eligible.push(c)
  }

  if (eligible.length === 0) {
    return {
      first_regular_publication_date: null,
      source: null,
      evidence_id: null,
      verified_at: verifiedAtIso,
      methodology_version: FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION,
      excluded_candidate_count: excludedCount,
      rejected_unrecognized_sources: rejectedUnrecognizedSources,
    }
  }

  // Pick the highest-priority source tier present, then the earliest date
  // within that tier.
  for (const tierSource of SOURCE_PRIORITY) {
    const inTier = eligible.filter(c => c.source === tierSource)
    if (inTier.length === 0) continue
    const earliest = inTier.reduce((min, c) => (c.date < min.date ? c : min))
    return {
      first_regular_publication_date: earliest.date,
      source: earliest.source,
      evidence_id: earliest.evidence_id ?? null,
      verified_at: verifiedAtIso,
      methodology_version: FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION,
      excluded_candidate_count: excludedCount,
      rejected_unrecognized_sources: rejectedUnrecognizedSources,
    }
  }

  // Unreachable given SOURCE_PRIORITY covers every valid `source`, but keep
  // an explicit fallback rather than an implicit `undefined` return.
  return {
    first_regular_publication_date: null,
    source: null,
    evidence_id: null,
    verified_at: verifiedAtIso,
    methodology_version: FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION,
    excluded_candidate_count: excludedCount,
    rejected_unrecognized_sources: rejectedUnrecognizedSources,
  }
}
