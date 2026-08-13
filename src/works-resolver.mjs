/**
 * Works resolver — Article-Sample ETL v1's normalization stage. Pure
 * functions only (no I/O — see `works-fetch.mjs` for the Crossref fetch
 * layer this consumes). Turns raw Crossref work records into the exact
 * shapes `ajr-early-stage.mjs` requires:
 *
 *   - `normalizeCrossrefWork()` / `selectArticleSample()` -> the `articles`
 *     array `scoreOutputSignals()` and `scoreReachConcentration()` take
 *     (Dimensions 5 and 6).
 *   - `deriveInfrastructureItemStatuses()` -> the six itemStatuses
 *     `scoreInfrastructure()` takes (Dimension 3).
 *   - `computePublicationWindowStats()` -> the `cadence`/`continuity`
 *     inputs `scorePublishingStability()` takes (Dimension 4), plus
 *     `deposit_timeliness`'s evidence status.
 *
 * `frequency_disclosed` (Dimension 4, weight 2) is deliberately NOT
 * resolved by this module — "is publication frequency disclosed on the
 * journal's own site" is a website-crawl question, not an article-data
 * question, and belongs in `evidence-resolver.mjs`'s EVIDENCE_CRITERIA
 * (which doesn't check it yet either — a known, separate, small gap; see
 * this module's own header note and the companion PR description). Reusing
 * `corpus/core-collection.json`'s `frequency` field (populated at
 * ingestion time from a person reading the journal's site, not from a
 * crawl-verified disclosure check) as a stand-in would be exactly the kind
 * of "claim more than was actually computed" this project has already had
 * to correct once — so this item stays `unknown` from this module, not a
 * guessed `met`.
 */

import { INFRASTRUCTURE_ITEMS } from './ajr-early-stage.mjs'

export const WORKS_RESOLVER_METHODOLOGY_VERSION = 'WORKS-1.0'

// ---------------------------------------------------------------------
// Raw Crossref work -> ajr-early-stage.mjs article shape
// ---------------------------------------------------------------------

/**
 * @param {{ 'date-parts'?: number[][] }} dateField - a Crossref date object
 *   (`published`, `issued`, `deposited`, `published-print`, ...)
 * @returns {string|null} ISO 'YYYY-MM-DD', missing month/day padded to 01
 *   (Crossref date-parts are sometimes year-only or year+month-only).
 */
export function crossrefDateToIso(dateField) {
  const parts = dateField?.['date-parts']?.[0]
  if (!Array.isArray(parts) || parts.length === 0 || !parts[0]) return null
  const [y, m = 1, d = 1] = parts
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function isoQuarter(iso) {
  if (!iso) return null
  const [y, m] = iso.split('-').map(Number)
  return `${y}-Q${Math.ceil(m / 3)}`
}

/**
 * @param {object} raw - one Crossref work-list item
 * @returns {{
 *   doi: string|null, title: string, hasAbstract: boolean,
 *   referenceCount: number, hasLicense: boolean, hasArchive: boolean,
 *   documentType: string|null, publishedDate: string|null,
 *   depositDate: string|null, issueOrPeriod: string|null,
 *   containerTitle: string|null,
 *   authors: { affiliation: string|null, orcid: string|null, given_name: string|null, family_name: string|null }[],
 * }}
 */
export function normalizeCrossrefWork(raw) {
  const publishedDate =
    crossrefDateToIso(raw.published) ??
    crossrefDateToIso(raw.issued) ??
    crossrefDateToIso(raw['published-print']) ??
    crossrefDateToIso(raw['published-online'])

  // Prefer volume/issue (a real editorial grouping) over a calendar-quarter
  // guess -- only falls back to the quarter derived from publishedDate when
  // a journal genuinely doesn't register volume/issue (common for
  // continuous-publication OJS journals with no issue structure at all).
  const issueOrPeriod = (raw.volume || raw.issue)
    ? `v${raw.volume ?? '?'}i${raw.issue ?? '?'}`
    : isoQuarter(publishedDate)

  return {
    doi: raw.DOI ?? null,
    title: Array.isArray(raw.title) ? (raw.title[0] ?? '') : (raw.title ?? ''),
    hasAbstract: Boolean(raw.abstract && String(raw.abstract).trim().length > 0),
    referenceCount: typeof raw['references-count'] === 'number' ? raw['references-count'] : 0,
    hasLicense: Array.isArray(raw.license) && raw.license.length > 0,
    hasArchive: Array.isArray(raw.archive) && raw.archive.length > 0,
    documentType: raw.type ?? null,
    publishedDate,
    depositDate: crossrefDateToIso(raw.deposited),
    issueOrPeriod,
    containerTitle: Array.isArray(raw['container-title']) ? (raw['container-title'][0] ?? null) : (raw['container-title'] ?? null),
    authors: (raw.author ?? []).map(normalizeCrossrefAuthor),
  }
}

function normalizeCrossrefAuthor(a) {
  const affiliations = Array.isArray(a.affiliation) ? a.affiliation.map(x => x?.name).filter(Boolean) : []
  return {
    affiliation: affiliations.length > 0 ? affiliations.join('; ') : null,
    orcid: a.ORCID ? String(a.ORCID).replace(/^https?:\/\/orcid\.org\//, '') : null,
    given_name: a.given ?? null,
    family_name: a.family ?? null,
  }
}

/**
 * Selects up to `target` articles spread across as many distinct
 * `issueOrPeriod` groups as the data actually has, instead of a flat
 * most-recent-N slice — directly serves AJR-E-1.1-SPEC.md § 7's "spanning
 * at least two issues/time periods where that data is available"
 * requirement, which `assessArticleSampleAdequacy()` in `ajr-early-stage.mjs`
 * only ever CHECKS for, never itself constructs. JUDGMENT CALL (flagged,
 * same disclosure style as `ajr-early-stage.mjs`'s own continuity/output
 * sub-scorers): a round-robin across groups, each internally already
 * sorted most-recent-first (Crossref's list is fetched `sort=published
 * &order=desc`), so the sample stays recency-biased within each group
 * while still spreading across groups.
 * @param {ReturnType<typeof normalizeCrossrefWork>[]} articles
 * @param {{ target?: number }} [opts]
 */
export function selectArticleSample(articles, opts = {}) {
  const { target = 30 } = opts
  const groups = new Map()
  for (const a of articles) {
    const key = a.issueOrPeriod ?? '__unknown_period__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(a)
  }
  const groupKeys = [...groups.keys()]
  const selected = []
  for (let round = 0; selected.length < target; round++) {
    let addedThisRound = false
    for (const key of groupKeys) {
      const arr = groups.get(key)
      if (arr[round]) {
        selected.push(arr[round])
        addedThisRound = true
        if (selected.length >= target) break
      }
    }
    if (!addedThisRound) break
  }
  return selected
}

// ---------------------------------------------------------------------
// Dimension 3 — Metadata & Digital Infrastructure item statuses
// ---------------------------------------------------------------------

const INFRA_WEIGHT_BY_ID = Object.fromEntries(INFRASTRUCTURE_ITEMS.map(i => [i.id, i.weight]))

function ratio(n, d) { return d > 0 ? n / d : null }

/**
 * All thresholds below are JUDGMENT CALLS (flagged, same disclosure style
 * `ajr-early-stage.mjs` itself uses for continuity/output-adequacy) — the
 * framework names these six items but, unlike cadence match, does not
 * specify exact pass/fail formulas for deriving them from raw article data.
 * Documented individually so a reviewer can argue with one threshold
 * without touching the others.
 *
 * @param {{
 *   sample: ReturnType<typeof normalizeCrossrefWork>[],
 *   doiChecks: { doi: string, resolved: boolean, http_status: number|null, error: string|null }[],
 *   oaiPmhCheck: { attempted: boolean, ok: boolean, http_status: number|null } | null,
 * }} input
 * @returns {Object<string,string>} keyed by INFRASTRUCTURE_ITEMS[].id, values are evidence-coverage.mjs statuses
 */
export function deriveInfrastructureItemStatuses({ sample, doiChecks, oaiPmhCheck }) {
  const n = sample.length

  // crossref_metadata_completeness: core bibliographic fields (title,
  // >=1 author, container title, a resolvable publication date, a DOI)
  // all present. Threshold: >=80% of the sample fully complete -> met.
  const completeCount = sample.filter(a =>
    a.title && a.title.length > 0 && a.authors.length > 0 && a.containerTitle && a.publishedDate && a.doi
  ).length
  const completenessRatio = ratio(completeCount, n)
  const crossref_metadata_completeness = completenessRatio == null ? 'unknown' : (completenessRatio >= 0.80 ? 'met' : 'not_met')

  // abstract_reference_license_metadata: average of three per-work binary
  // signals (has abstract, has >=1 reference, has a license) across the
  // sample. Abstract deposit is legitimately optional/uncommon for many
  // small OJS journals even when the journal is otherwise well-run, so this
  // is an average across all three signals, not a strict AND — threshold
  // >=60% average -> met.
  const abstractRefLicenseAvg = n > 0
    ? sample.reduce((s, a) => s + ((a.hasAbstract ? 1 : 0) + (a.referenceCount > 0 ? 1 : 0) + (a.hasLicense ? 1 : 0)) / 3, 0) / n
    : null
  const abstract_reference_license_metadata = abstractRefLicenseAvg == null ? 'unknown' : (abstractRefLicenseAvg >= 0.60 ? 'met' : 'not_met')

  // structured_author_affiliation_identifiers: fraction of AUTHOR-SLOTS
  // (not works) with an ORCID or a structured affiliation string present.
  // Threshold: >=50% -> met.
  const allAuthors = sample.flatMap(a => a.authors)
  const structuredAuthorCount = allAuthors.filter(au => au.orcid || au.affiliation).length
  const structuredRatio = ratio(structuredAuthorCount, allAuthors.length)
  const structured_author_affiliation_identifiers = structuredRatio == null ? 'unknown' : (structuredRatio >= 0.50 ? 'met' : 'not_met')

  // doi_resolution_reliability: real doi.org resolution checks (see
  // works-fetch.mjs#checkDoiResolution()) against a sample of the
  // journal's own DOIs. >=80% resolved among CHECKED dois -> met. No
  // checks attempted (e.g. no DOIs in sample at all) -> unknown, never a
  // penalized not_met.
  const attemptedDoiChecks = (doiChecks ?? []).filter(c => c.http_status !== null || c.resolved)
  const resolvedCount = attemptedDoiChecks.filter(c => c.resolved).length
  const doiRatio = ratio(resolvedCount, attemptedDoiChecks.length)
  const doi_resolution_reliability = doiRatio == null ? 'unknown' : (doiRatio >= 0.80 ? 'met' : 'not_met')

  // oai_pmh_schema_org_machine_readable: a real live check against the
  // journal's own oai_base_url (corpus field), when one exists. Journals
  // with no oai_base_url on record are `unknown` -- an untried check, not
  // a confirmed absence -- never `not_met`.
  let oai_pmh_schema_org_machine_readable
  if (!oaiPmhCheck || !oaiPmhCheck.attempted) oai_pmh_schema_org_machine_readable = 'unknown'
  else oai_pmh_schema_org_machine_readable = oaiPmhCheck.ok ? 'met' : (oaiPmhCheck.http_status == null ? 'unknown' : 'not_met')

  // digital_preservation_archiving: Crossref's own per-work `archive` field
  // (CLOCKSS/Portico/LOCKSS registration) -- real signal, expected to
  // legitimately read `not_met` for most small/new journals that haven't
  // set up third-party archiving yet; that is an honest finding, not a
  // resolver defect.
  const digital_preservation_archiving = n === 0 ? 'unknown' : (sample.some(a => a.hasArchive) ? 'met' : 'not_met')

  return {
    doi_resolution_reliability,
    crossref_metadata_completeness,
    abstract_reference_license_metadata,
    structured_author_affiliation_identifiers,
    oai_pmh_schema_org_machine_readable,
    digital_preservation_archiving,
  }
}

export { INFRA_WEIGHT_BY_ID }

// ---------------------------------------------------------------------
// Dimension 4 — Publishing Stability inputs (cadence / continuity / deposit timeliness)
// ---------------------------------------------------------------------

/** Expected months between publications for a stated periodic frequency.
 * `Continuous` and `Irregular` are deliberately absent — see
 * `computePublicationWindowStats()`'s header: cadence match requires a
 * genuinely PERIODIC stated frequency to have a defined "expected window,"
 * which those two values explicitly do not claim to have. */
export const FREQUENCY_WINDOW_MONTHS = Object.freeze({
  Monthly: 1,
  Bimonthly: 2,
  Quarterly: 3,
  Biannual: 6,
  Annual: 12,
})

/** Fixed window size for the Publication Continuity sub-score, independent
 * of the journal's own stated cadence -- continuity asks "did activity
 * continue at all over time," which is answerable for a Continuous/
 * Irregular journal the same as a Monthly one, unlike cadence match (which
 * is specifically about matching a STATED periodic promise). JUDGMENT
 * CALL, documented per `ajr-early-stage.mjs`'s own disclosure convention
 * for this sub-item. */
export const CONTINUITY_WINDOW_MONTHS = 3

function monthsBetween(isoStart, isoEnd) {
  const [ys, ms] = isoStart.split('-').map(Number)
  const [ye, me] = isoEnd.split('-').map(Number)
  return (ye - ys) * 12 + (me - ms)
}

/**
 * @param {string[]} publishedDates - every ISO publication date this
 *   journal has (ideally the FULL set, not just the up-to-30 scoring
 *   sample, so cadence/continuity reflect real publishing activity rather
 *   than an under-sampled slice — see run-works-etl.mjs's separate
 *   lightweight date-only fetch).
 * @param {{ frequency: string|null, firstPublicationDate: string|null, ratingDate: string, totalArticleCount: number|null }} context
 * @returns {{
 *   cadence: { expectedWindows: number, metWindows: number },
 *   continuity: { totalWindows: number, activeWindows: number },
 *   deposit_timeliness: string,
 * }}
 */
export function computePublicationWindowStats(publishedDates, context) {
  const { frequency, firstPublicationDate, ratingDate } = context
  const dates = (publishedDates ?? []).filter(Boolean)

  let cadence = { expectedWindows: 0, metWindows: 0 }
  const windowMonths = frequency ? FREQUENCY_WINDOW_MONTHS[frequency] : undefined
  if (windowMonths && firstPublicationDate) {
    const totalMonths = monthsBetween(firstPublicationDate, ratingDate)
    const expectedWindows = Math.max(0, Math.floor(totalMonths / windowMonths))
    if (expectedWindows > 0) {
      const metBuckets = new Set()
      for (const d of dates) {
        const m = monthsBetween(firstPublicationDate, d)
        if (m < 0) continue
        const bucket = Math.min(Math.floor(m / windowMonths), expectedWindows - 1)
        metBuckets.add(bucket)
      }
      cadence = { expectedWindows, metWindows: metBuckets.size }
    }
  }
  // frequency is null/unrecognized (e.g. 'Continuous', 'Irregular') or no
  // firstPublicationDate on record -> cadence stays {0, 0}, which
  // computeCadenceScore() (ajr-early-stage.mjs) reads as "not computable,"
  // returning a null (not zero) score — correct: a non-periodic journal has
  // no stated cadence to be judged against, not a failing cadence.

  let continuity = { totalWindows: 0, activeWindows: 0 }
  if (firstPublicationDate) {
    const totalMonths = monthsBetween(firstPublicationDate, ratingDate)
    const totalWindows = Math.max(0, Math.ceil(totalMonths / CONTINUITY_WINDOW_MONTHS))
    if (totalWindows > 0) {
      const activeBuckets = new Set()
      for (const d of dates) {
        const m = monthsBetween(firstPublicationDate, d)
        if (m < 0) continue
        activeBuckets.add(Math.min(Math.floor(m / CONTINUITY_WINDOW_MONTHS), totalWindows - 1))
      }
      continuity = { totalWindows, activeWindows: activeBuckets.size }
    }
  }

  return { cadence, continuity }
}

/**
 * deposit_timeliness (Dimension 4, weight 2) — how promptly a journal
 * registers its own published works with Crossref, real signal from each
 * sampled work's `deposited` vs `published` gap. Threshold: median gap
 * <=90 days -> met (a generous bar; OJS journals commonly batch-deposit).
 * @param {{ publishedDate: string|null, depositDate: string|null }[]} sample
 * @returns {string} an evidence-coverage.mjs status
 */
export function deriveDepositTimeliness(sample) {
  const gaps = (sample ?? [])
    .filter(a => a.publishedDate && a.depositDate)
    .map(a => Math.round((new Date(a.depositDate) - new Date(a.publishedDate)) / 86400000))
    .filter(g => Number.isFinite(g))
  if (gaps.length === 0) return 'unknown'
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return median <= 90 ? 'met' : 'not_met'
}
