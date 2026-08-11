/**
 * Journal lifecycle classification — implements posi-data/AJR-SPEC.md § 1
 * and the "POSI Journal Evaluation & Ranking Framework 1.0" lifecycle
 * section (fixed boundary logic).
 *
 * Pure functions: given a journal's first-publication date and the rating
 * cutoff date, determine its lifecycle stage. No I/O — resolving what a
 * journal's first-publication date actually is (Crossref/OpenAlex lookups,
 * see first-publication-date.mjs) is the caller's responsibility; this
 * module only does the boundary arithmetic and stage naming, which is
 * exactly the part that needs to be identical everywhere it's used (the
 * website repo's daily sync, any future posi-engine release pipeline, etc.)
 * rather than reimplemented per caller.
 *
 * LIFECYCLE-1.1 fixes a real boundary bug in LIFECYCLE-1.0: the original
 * `monthsSince()` used calendar-month subtraction
 * (`asOf.getMonth() - from.getMonth()`, adjusted by year), which is wrong
 * at month-end boundaries — a journal launched 2025-08-31 was counted as
 * "12 months old" on 2026-08-01 (only 31 days later, not 12 months), simply
 * because the calendar month rolled over. LIFECYCLE-1.1 replaces the stage
 * decision with exact date-boundary arithmetic:
 *
 *   rating_date < launch_date + 12 months  -> Observation
 *   rating_date < launch_date + 60 months  -> Early-Stage
 *   otherwise                              -> Mature
 *
 * `+ N months` is calendar-month addition on the launch date itself (via
 * `Date.UTC(...).setUTCMonth`), which correctly handles month-length
 * differences (e.g. launch_date 2025-08-31 + 1 month lands on 2025-10-01,
 * JS Date's own well-defined overflow behavior for a day that doesn't exist
 * in the target month — this project accepts that standard behavior rather
 * than inventing a custom "clamp to month end" rule, since it is at most a
 * few days of skew at the observation/early-stage boundary and is fully
 * deterministic).
 *
 * `monthsSince()` is kept as a calendar-month DIAGNOSTIC/display figure
 * only (e.g. "approximately 14 months old") — it must never again be used
 * to decide the lifecycle stage itself; `classifyLifecycleStage()` (the
 * months-based function) is deprecated for that reason and now delegates
 * to the date-based boundary check internally so the two can never drift
 * apart.
 */

export const LIFECYCLE_METHODOLOGY_VERSION = 'LIFECYCLE-1.1'

export const OBSERVATION_MAX_MONTHS = 11
export const EARLY_STAGE_MAX_MONTHS = 59

const OBSERVATION_BOUNDARY_MONTHS = 12
const MATURE_BOUNDARY_MONTHS = 60

function toUtcMidnight(dateOrIso) {
  if (dateOrIso instanceof Date) {
    return new Date(Date.UTC(dateOrIso.getFullYear(), dateOrIso.getMonth(), dateOrIso.getDate()))
  }
  // Plain 'YYYY-MM-DD' parses as UTC midnight already in ISO 8601; guard
  // against accidental local-time strings by re-deriving from components.
  const [y, m, d] = String(dateOrIso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/**
 * Adds `months` calendar months to a date, in UTC, avoiding local-timezone
 * skew at month boundaries.
 * @param {Date} utcDate
 * @param {number} months
 * @returns {Date}
 */
export function addMonthsUtc(utcDate, months) {
  const d = new Date(utcDate.getTime())
  d.setUTCMonth(d.getUTCMonth() + months)
  return d
}

/**
 * @param {string} firstPublishedIso - ISO date string, e.g. '2025-04-03'
 * @param {Date} asOf - the rating cutoff date
 * @returns {number} whole calendar months elapsed — DIAGNOSTIC/DISPLAY ONLY,
 *   never use this to decide lifecycle stage (see module header).
 */
export function monthsSince(firstPublishedIso, asOf) {
  const from = toUtcMidnight(firstPublishedIso)
  const to = toUtcMidnight(asOf)
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  if (to.getUTCDate() < from.getUTCDate()) months -= 1
  return months
}

/**
 * Exact date-boundary lifecycle stage decision (LIFECYCLE-1.1). This is the
 * authoritative stage calculation — see module header for why it replaces
 * calendar-month counting.
 * @param {string|null} firstPublishedIso - ISO date string, or null/unknown
 * @param {Date} asOf - the rating cutoff date
 * @returns {'unknown'|'observation'|'early_stage'|'mature'}
 */
export function classifyLifecycleStageByDate(firstPublishedIso, asOf) {
  if (!firstPublishedIso) return 'unknown'
  const launch = toUtcMidnight(firstPublishedIso)
  const ratingDate = toUtcMidnight(asOf)
  if (ratingDate < launch) return 'unknown' // launch date in the future relative to asOf — malformed input, not a stage

  const observationBoundary = addMonthsUtc(launch, OBSERVATION_BOUNDARY_MONTHS)
  const matureBoundary = addMonthsUtc(launch, MATURE_BOUNDARY_MONTHS)

  if (ratingDate < observationBoundary) return 'observation'
  if (ratingDate < matureBoundary) return 'early_stage'
  return 'mature'
}

/**
 * @deprecated Use classifyLifecycleStageByDate() with the actual dates —
 * this months-based signature can't reproduce exact date-boundary
 * arithmetic (see module header) and is kept only so any caller still
 * passing a pre-computed month count doesn't hard-break. It now derives its
 * answer from the same fixed OBSERVATION_MAX_MONTHS/EARLY_STAGE_MAX_MONTHS
 * cut points, on whole months — which is the *diagnostic* month count from
 * monthsSince(), not the exact-date boundary. Prefer classifyLifecycle().
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
 * Convenience wrapper: the exact-date stage decision (authoritative) plus
 * the calendar-month figure (diagnostic/display only).
 * @param {string|null} firstPublishedIso
 * @param {Date} asOf
 * @returns {{ months_since_launch: number|null, lifecycle_stage: 'unknown'|'observation'|'early_stage'|'mature', methodology_version: string }}
 */
export function classifyLifecycle(firstPublishedIso, asOf) {
  if (!firstPublishedIso) {
    return { months_since_launch: null, lifecycle_stage: 'unknown', methodology_version: LIFECYCLE_METHODOLOGY_VERSION }
  }
  return {
    months_since_launch: monthsSince(firstPublishedIso, asOf),
    lifecycle_stage: classifyLifecycleStageByDate(firstPublishedIso, asOf),
    methodology_version: LIFECYCLE_METHODOLOGY_VERSION,
  }
}
