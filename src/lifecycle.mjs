/**
 * Journal lifecycle classification — implements posi-data/AJR-SPEC.md § 1.
 *
 * Pure functions: given a journal's first-publication date and the rating
 * cutoff date, determine its lifecycle stage. No I/O — resolving what a
 * journal's first-publication date actually is (Crossref/OpenAlex lookups)
 * is the caller's responsibility; this module only does the month-bucket
 * arithmetic and stage naming, which is exactly the part that needs to be
 * identical everywhere it's used (the website repo's daily sync, any
 * future posi-engine release pipeline, etc.) rather than reimplemented
 * per caller.
 *
 * Supersedes the two-way rated/rated_mature split used by AJR v0.3 (a
 * single 36-month boundary, no distinct "too young to evaluate at all"
 * stage) with AJR 1.0's three-stage model.
 */

export const LIFECYCLE_METHODOLOGY_VERSION = 'LIFECYCLE-1.0'

export const OBSERVATION_MAX_MONTHS = 11
export const EARLY_STAGE_MAX_MONTHS = 59

/**
 * @param {string} firstPublishedIso - ISO date string, e.g. '2025-04-03'
 * @param {Date} asOf - the rating cutoff date
 * @returns {number} whole months elapsed (can be 0 for the current month)
 */
export function monthsSince(firstPublishedIso, asOf) {
  const from = new Date(firstPublishedIso)
  return (asOf.getFullYear() - from.getFullYear()) * 12 + (asOf.getMonth() - from.getMonth())
}

/**
 * @param {number|null} months - result of monthsSince(), or null if the
 *   first-publication date could not be determined
 * @returns {'unknown'|'observation'|'early_stage'|'mature'}
 */
export function classifyLifecycleStage(months) {
  if (months == null || months < 0) return 'unknown'
  if (months <= OBSERVATION_MAX_MONTHS) return 'observation'
  if (months <= EARLY_STAGE_MAX_MONTHS) return 'early_stage'
  return 'mature'
}

/**
 * Convenience wrapper combining the two functions above.
 * @param {string|null} firstPublishedIso
 * @param {Date} asOf
 * @returns {{ months_since_launch: number|null, lifecycle_stage: 'unknown'|'observation'|'early_stage'|'mature' }}
 */
export function classifyLifecycle(firstPublishedIso, asOf) {
  if (!firstPublishedIso) return { months_since_launch: null, lifecycle_stage: 'unknown' }
  const months = monthsSince(firstPublishedIso, asOf)
  return { months_since_launch: months, lifecycle_stage: classifyLifecycleStage(months) }
}
