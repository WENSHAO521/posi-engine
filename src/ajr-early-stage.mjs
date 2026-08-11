/**
 * AJR-E — POSI Automated Journal Rating, Early-Stage model (12-59 months).
 * Implements the "POSI Journal Evaluation & Ranking Framework 1.0" AJR-E
 * section — **AJR-E 1.1**, a new versioned spec (posi-data/AJR-E-1.1-SPEC.md)
 * that supersedes AJR-E-1.0's rubric with several bug fixes. AJR-E-1.0
 * stays published as-is (posi-data/AJR-SPEC.md / EARLY-STAGE-RATING-SPEC.md)
 * — this is a new version, not a silent edit of what 1.0 meant; every score
 * computed by this module stamps `methodology_version: 'AJR-E-1.1'` so
 * historical 1.0 scores are never conflated with 1.1 ones.
 *
 * Bug fixes vs. AJR-E-1.0 (each called out explicitly by the framework):
 *   - Research Integrity no longer infers Authorship/COI oversight from
 *     "Editorial Board exists" (+3 auto-credit removed). Authorship Policy
 *     and COI Policy are now independent evidence items, `unknown` (not
 *     auto-`met`) until real evidence is supplied.
 *   - Infrastructure no longer gives a "+4 if OpenAlex Source exists"
 *     bonus — OpenAlex indexing is an external platform's own editorial
 *     decision, not a POSI-observed quality signal. robots.txt presence
 *     may still be surfaced as a diagnostic display field (see
 *     `robotsTxtDiagnostic()`) but carries zero scoring weight here.
 *   - Publishing Stability's cadence sub-score is now a tiered, formulaic
 *     computation (>=90% of expected windows met -> 5, 75-89% -> 4,
 *     60-74% -> 2, <60% -> 0) instead of a flat boolean/heuristic.
 *   - Scholarly Reach & Concentration's author-identity resolution is now
 *     ORCID -> normalized given+family name ONLY — affiliation strings are
 *     used exclusively for institution concentration, never as an author
 *     identity proxy (the old code kept `au.orcid ?? au.affiliation` as
 *     the author "key", which conflated two different concentration
 *     questions).
 *   - Article sample size: minimum 10, TARGET 30, spanning at least two
 *     issues/time periods where available (was most-recent-10 flat).
 *
 * Every evidence-backed dimension (1, 2, 3, 4's disclosure items, 7) is
 * built on evidence-coverage.mjs's dimensionScore(), so callers get the
 * framework's Evidence Coverage normalization (an uncheckable item never
 * silently scores as failed) automatically — see that module for the
 * seven-state status model. Dimensions 5 and 6 are computed directly from
 * a sampled-articles list (there is no "evidence status" for e.g.
 * "average reference count" — it's a number, not a disclosure check).
 *
 * Pure functions throughout: every scorer takes already-fetched evidence.
 * No I/O. Governing principle unchanged (AJR-SPEC.md § 11): no reviewer,
 * editor, publisher, sponsor, or POSI administrator has a code path to set
 * a score directly — only the underlying evidence can be corrected.
 */

import { dimensionScore } from './evidence-coverage.mjs'
import { scoreTransparency } from './shared-dimensions.mjs'

export const AJR_E_METHODOLOGY_VERSION = 'AJR-E-1.1'

export const MIN_ARTICLE_SAMPLE_SIZE = 10
export const TARGET_ARTICLE_SAMPLE_SIZE = 30

export function clamp(v, max) { return Math.max(0, Math.min(v, max)) }

// ---------------------------------------------------------------------
// Dimension 1 — Editorial Governance & Peer Review (15)
// ---------------------------------------------------------------------

export const EDITORIAL_GOVERNANCE_WEIGHT = 15
export const EDITORIAL_GOVERNANCE_ITEMS = Object.freeze([
  { id: 'aims_scope_explicit', weight: 2 },
  { id: 'editorial_board_public', weight: 3 },
  { id: 'editor_identity_affiliation_verifiable', weight: 2 },
  { id: 'peer_review_process_disclosed', weight: 4 },
  { id: 'reviewer_editorial_guidelines', weight: 2 },
  { id: 'complaints_appeals', weight: 2 },
])

/** @param {Object<string,string>} itemStatuses - keyed by EDITORIAL_GOVERNANCE_ITEMS[].id */
export function scoreEditorialGovernance(itemStatuses = {}) {
  const items = EDITORIAL_GOVERNANCE_ITEMS.map(s => ({ id: s.id, weight: s.weight, status: itemStatuses[s.id] ?? 'unknown' }))
  return { ...dimensionScore(items, EDITORIAL_GOVERNANCE_WEIGHT), items }
}

// ---------------------------------------------------------------------
// Dimension 2 — Research Integrity (15)
// ---------------------------------------------------------------------

export const RESEARCH_INTEGRITY_WEIGHT = 15
export const RESEARCH_INTEGRITY_ITEMS = Object.freeze([
  { id: 'publication_ethics_policy', weight: 3 },
  { id: 'corrections_retractions_policy', weight: 3 },
  { id: 'authorship_contributorship_policy', weight: 2 }, // BUG FIX: no longer proxied from editorial_board_public
  { id: 'conflict_of_interest_policy', weight: 2 },        // BUG FIX: no longer proxied from editorial_board_public
  { id: 'plagiarism_similarity_policy', weight: 2 },
  { id: 'human_animal_ethics_consent', weight: 1 },
  { id: 'data_availability_sharing', weight: 1 },
  { id: 'ai_use_policy', weight: 1 },
])

/** @param {Object<string,string>} itemStatuses - keyed by RESEARCH_INTEGRITY_ITEMS[].id.
 *   Deliberately does NOT accept an `editorialBoard` shortcut — see module header. */
export function scoreResearchIntegrity(itemStatuses = {}) {
  const items = RESEARCH_INTEGRITY_ITEMS.map(s => ({ id: s.id, weight: s.weight, status: itemStatuses[s.id] ?? 'unknown' }))
  return { ...dimensionScore(items, RESEARCH_INTEGRITY_WEIGHT), items }
}

// ---------------------------------------------------------------------
// Dimension 3 — Metadata & Digital Infrastructure (15)
// ---------------------------------------------------------------------

export const INFRASTRUCTURE_WEIGHT = 15
export const INFRASTRUCTURE_ITEMS = Object.freeze([
  { id: 'doi_resolution_reliability', weight: 3 },
  { id: 'crossref_metadata_completeness', weight: 3 },
  { id: 'abstract_reference_license_metadata', weight: 3 },
  { id: 'structured_author_affiliation_identifiers', weight: 2 },
  { id: 'oai_pmh_schema_org_machine_readable', weight: 2 },
  { id: 'digital_preservation_archiving', weight: 2 },
  // NOTE: no "openalex_indexed" item exists here on purpose — BUG FIX, see
  // module header. Do not add one back.
])

/** @param {Object<string,string>} itemStatuses - keyed by INFRASTRUCTURE_ITEMS[].id */
export function scoreInfrastructure(itemStatuses = {}) {
  const items = INFRASTRUCTURE_ITEMS.map(s => ({ id: s.id, weight: s.weight, status: itemStatuses[s.id] ?? 'unknown' }))
  return { ...dimensionScore(items, INFRASTRUCTURE_WEIGHT), items }
}

/**
 * robots.txt presence is a DIAGNOSTIC display field only (framework: "may
 * stay as a diagnostic display field but must not be a high-weight scored
 * item"). This function exists so a caller has one canonical place to
 * surface it, rather than folding it into scoreInfrastructure()'s items
 * (which would re-introduce scoring weight for it).
 * @param {boolean|null} robotsTxtFound
 * @returns {{ robots_txt_found: boolean|null, scored: false }}
 */
export function robotsTxtDiagnostic(robotsTxtFound) {
  return { robots_txt_found: robotsTxtFound ?? null, scored: false }
}

// ---------------------------------------------------------------------
// Dimension 4 — Publishing Stability & Operational Performance (15)
// ---------------------------------------------------------------------

export const PUBLISHING_STABILITY_WEIGHT = 15
const FREQUENCY_DISCLOSED_WEIGHT = 2
const CADENCE_MATCH_WEIGHT = 5
const CONTINUITY_WEIGHT = 3
const OUTPUT_ADEQUACY_WEIGHT = 3
const DEPOSIT_TIMELINESS_WEIGHT = 2

/**
 * Cadence match (5 pts) — tiered, automatic, per the framework's exact
 * table. `expectedWindows` is however many publication windows (issues,
 * months, whatever cadence unit the journal states) should have occurred
 * since launch given its disclosed frequency; `metWindows` is how many of
 * those actually had at least one qualifying publication.
 * @param {number} expectedWindows
 * @param {number} metWindows
 * @returns {{ score: number|null, ratio: number|null }} score is null (not
 *   0) when expectedWindows <= 0 — there is no basis to compute a ratio at
 *   all, which is a different situation from "computed and it was 0%".
 */
export function computeCadenceScore(expectedWindows, metWindows) {
  if (!expectedWindows || expectedWindows <= 0) return { score: null, ratio: null }
  const ratio = clamp(metWindows, expectedWindows) / expectedWindows
  let score
  if (ratio >= 0.90) score = 5
  else if (ratio >= 0.75) score = 4
  else if (ratio >= 0.60) score = 2
  else score = 0
  return { score, ratio }
}

/**
 * Publication continuity (3 pts) — proportional to the share of sampled
 * rolling activity windows (e.g. consecutive quarters since launch) that
 * had at least one publication. JUDGMENT CALL (flagged): the framework
 * names this sub-item but does not give an exact formula the way it does
 * for cadence — a simple linear proportion of active windows is used here,
 * documented so a reviewer can argue with the choice specifically.
 * @param {number} totalWindows
 * @param {number} activeWindows
 * @returns {{ score: number|null, ratio: number|null }}
 */
export function computeContinuityScore(totalWindows, activeWindows) {
  if (!totalWindows || totalWindows <= 0) return { score: null, ratio: null }
  const ratio = clamp(activeWindows, totalWindows) / totalWindows
  return { score: round2(CONTINUITY_WEIGHT * ratio), ratio }
}

/**
 * Output adequacy (3 pts) — proportional to actual article count against
 * an expected minimum derived from months since launch (same underlying
 * idea as AJR-E-1.0's flat gate, now a proportional score instead of a
 * pass/fail cliff — JUDGMENT CALL, same disclosure as computeContinuityScore).
 * Expected minimum: roughly one qualifying article every two months
 * (unchanged assumption from AJR-E-1.0) — a journal meeting or exceeding
 * that gets full marks; below it, scored proportionally rather than zeroed
 * outright.
 * @param {number} articleCount
 * @param {number|null} monthsSinceLaunch
 * @returns {{ score: number|null, expected: number|null }}
 */
export function computeOutputAdequacyScore(articleCount, monthsSinceLaunch) {
  if (monthsSinceLaunch == null || monthsSinceLaunch <= 0) return { score: null, expected: null }
  const expected = Math.max(1, monthsSinceLaunch / 2)
  const ratio = clamp(articleCount / expected, 1)
  return { score: round2(OUTPUT_ADEQUACY_WEIGHT * ratio), expected }
}

/**
 * @param {{ frequency_disclosed?: string, deposit_timeliness?: string }} evidenceStatuses
 *   - keyed evidence items (frequency_disclosed weight 2, deposit_timeliness weight 2)
 * @param {{ expectedWindows: number, metWindows: number }} cadence
 * @param {{ totalWindows: number, activeWindows: number }} continuity
 * @param {{ articleCount: number, monthsSinceLaunch: number|null }} output
 */
export function scorePublishingStability(evidenceStatuses, cadence, continuity, output) {
  const freqItem = { id: 'frequency_disclosed', weight: FREQUENCY_DISCLOSED_WEIGHT, status: evidenceStatuses.frequency_disclosed ?? 'unknown' }
  const depositItem = { id: 'deposit_timeliness', weight: DEPOSIT_TIMELINESS_WEIGHT, status: evidenceStatuses.deposit_timeliness ?? 'unknown' }
  const freqScore = dimensionScore([freqItem], FREQUENCY_DISCLOSED_WEIGHT)
  const depositScore = dimensionScore([depositItem], DEPOSIT_TIMELINESS_WEIGHT)

  const cadenceResult = computeCadenceScore(cadence?.expectedWindows, cadence?.metWindows)
  const continuityResult = computeContinuityScore(continuity?.totalWindows, continuity?.activeWindows)
  const outputResult = computeOutputAdequacyScore(output?.articleCount, output?.monthsSinceLaunch)

  const total = round2(
    freqScore.score +
    (cadenceResult.score ?? 0) +
    (continuityResult.score ?? 0) +
    (outputResult.score ?? 0) +
    depositScore.score
  )

  return {
    score: clamp(total, PUBLISHING_STABILITY_WEIGHT),
    subfactors: {
      frequency_disclosed: freqScore,
      cadence_match: cadenceResult,
      publication_continuity: continuityResult,
      output_adequacy: outputResult,
      deposit_timeliness: depositScore,
    },
  }
}

// ---------------------------------------------------------------------
// Dimension 5 — Scholarly Output Quality Signals (20)
// ---------------------------------------------------------------------

export const OUTPUT_SIGNALS_WEIGHT = 20

function normalizeForDup(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/**
 * @param {{ title: string, hasAbstract: boolean, referenceCount: number, hasLicense: boolean, documentType?: string, publishedDate: string|null, issueOrPeriod?: string|null, authors: { affiliation: string|null, orcid: string|null }[] }[]} articles
 * @returns {{ sufficient: boolean, size: number, meets_target: boolean, spans_multiple_periods: boolean, note: string }}
 */
export function assessArticleSampleAdequacy(articles) {
  const size = articles?.length ?? 0
  const periods = new Set((articles ?? []).map(a => a.issueOrPeriod).filter(Boolean))
  const spansMultiplePeriods = periods.size >= 2
  const sufficient = size >= MIN_ARTICLE_SAMPLE_SIZE
  const meetsTarget = size >= TARGET_ARTICLE_SAMPLE_SIZE
  let note
  if (!sufficient) note = `sample of ${size} is below the minimum of ${MIN_ARTICLE_SAMPLE_SIZE} — Output Signals cannot be reliably scored`
  else if (!meetsTarget) note = `sample of ${size} clears the minimum (${MIN_ARTICLE_SAMPLE_SIZE}) but is below the target of ${TARGET_ARTICLE_SAMPLE_SIZE}`
  else note = `sample of ${size} meets the target of ${TARGET_ARTICLE_SAMPLE_SIZE}`
  if (sufficient && !spansMultiplePeriods) note += '; sample does not span multiple issues/time periods where that data was available'
  return { sufficient, size, meets_target: meetsTarget, spans_multiple_periods: spansMultiplePeriods, note }
}

/**
 * @param {Parameters<typeof assessArticleSampleAdequacy>[0]} articles
 * @returns {{ score: number, subfactors: object, sample: ReturnType<typeof assessArticleSampleAdequacy> }}
 */
export function scoreOutputSignals(articles) {
  const sample = assessArticleSampleAdequacy(articles)
  if (!articles || articles.length === 0 || !sample.sufficient) {
    return { score: 0, subfactors: null, sample }
  }

  // Article structural completeness (6)
  let completenessSum = 0
  for (const a of articles) {
    const fields = [a.hasAbstract, a.referenceCount > 0, a.authors.some(x => x.affiliation), a.authors.some(x => x.orcid), a.hasLicense]
    completenessSum += fields.filter(Boolean).length / fields.length
  }
  const structuralCompleteness = round2((completenessSum / articles.length) * 6)

  // Reference integrity/completeness (4)
  const avgRefs = articles.reduce((s, a) => s + a.referenceCount, 0) / articles.length
  const referenceIntegrity = avgRefs >= 15 ? 4 : avgRefs >= 8 ? 2.5 : avgRefs >= 1 ? 1 : 0

  // Article type/title/abstract integrity (3): non-empty title, plausible
  // length, and hasAbstract already counted in structural completeness —
  // this sub-score focuses specifically on document_type being a
  // recognizable, non-placeholder value and title not being empty/generic.
  const validTypeCount = articles.filter(a => a.documentType && a.documentType.length > 0).length
  const nonEmptyTitleCount = articles.filter(a => a.title && a.title.trim().length > 3).length
  const typeIntegrity = round2(3 * ((validTypeCount + nonEmptyTitleCount) / (2 * articles.length)))

  // Duplicate/template anomaly detection (3)
  let patternScore = 3
  const normTitles = articles.map(a => normalizeForDup(a.title))
  const titleCounts = new Map()
  for (const t of normTitles) if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1)
  const hasDuplicateTitle = [...titleCounts.values()].some(c => c > 1)
  if (hasDuplicateTitle) patternScore -= 1.5

  // Authorship-pattern anomaly (2) — uses ORCID/name identity, same
  // resolution rule as scoreReachConcentration (see resolveAuthorIdentity()).
  const authorCounts = new Map()
  for (const a of articles) {
    for (const au of a.authors) {
      const key = resolveAuthorIdentity(au)
      if (!key) continue
      authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1)
    }
  }
  let authorshipAnomaly = 2
  const maxAuthorShare = authorCounts.size > 0 ? Math.max(...authorCounts.values()) / articles.length : 0
  if (maxAuthorShare > 0.6) authorshipAnomaly -= 1

  // Publication/date-pattern consistency (2)
  let dateConsistency = 2
  const dates = articles.map(a => a.publishedDate).filter(Boolean)
  if (dates.length >= 5 && new Set(dates).size === 1) dateConsistency -= 1 // batch-dump on a single date

  const total = round2(structuralCompleteness + referenceIntegrity + typeIntegrity + clamp(patternScore, 3) + clamp(authorshipAnomaly, 2) + clamp(dateConsistency, 2))

  return {
    score: clamp(total, OUTPUT_SIGNALS_WEIGHT),
    subfactors: {
      structural_completeness: structuralCompleteness,
      reference_integrity: referenceIntegrity,
      type_title_abstract_integrity: typeIntegrity,
      duplicate_template_anomaly: clamp(patternScore, 3),
      authorship_pattern_anomaly: clamp(authorshipAnomaly, 2),
      date_pattern_consistency: clamp(dateConsistency, 2),
    },
    sample,
  }
}

// ---------------------------------------------------------------------
// Dimension 6 — Scholarly Reach & Concentration (10)
// ---------------------------------------------------------------------

export const REACH_CONCENTRATION_WEIGHT = 10

function normalizeAffiliation(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

function normalizeNamePart(s) {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * BUG FIX (framework, verbatim): "author identity must resolve via ORCID
 * -> normalized given+family name, never via affiliation-as-identity-proxy
 * (affiliation is for institution concentration only, not author
 * identity)." Returns null when neither an ORCID nor a full given+family
 * name is available — such an author is simply excluded from
 * author-concentration counting (their affiliation still counts toward
 * institution concentration separately), rather than silently keyed by
 * affiliation the way AJR-E-1.0 did.
 * @param {{ orcid?: string|null, given_name?: string|null, family_name?: string|null }} author
 * @returns {string|null}
 */
export function resolveAuthorIdentity(author) {
  if (author.orcid) return `orcid:${author.orcid.trim()}`
  const given = normalizeNamePart(author.given_name)
  const family = normalizeNamePart(author.family_name)
  if (given && family) return `name:${given} ${family}`
  return null
}

function tierInstitutionConcentration(maxShare) {
  if (maxShare <= 0.40) return 4
  if (maxShare <= 0.60) return 3
  if (maxShare <= 0.80) return 1
  return 0
}

function tierAuthorConcentration(maxShare) {
  if (maxShare <= 0.25) return 3
  if (maxShare <= 0.40) return 2
  if (maxShare <= 0.60) return 1
  return 0
}

/**
 * @param {{ authors: { affiliation: string|null, orcid?: string|null, given_name?: string|null, family_name?: string|null }[] }[]} articles
 */
export function scoreReachConcentration(articles) {
  const totalAuthors = articles.reduce((s, a) => s + a.authors.length, 0)

  // Institution Concentration (4) + Institutional Breadth (3), both from
  // resolvable affiliation strings.
  const affiliations = articles.flatMap(a => a.authors.map(au => au.affiliation).filter(Boolean))
  let institutionConcentration, institutionalBreadth, institutionNote
  if (totalAuthors === 0 || affiliations.length / totalAuthors < 0.3) {
    // Sparse affiliation metadata is a completeness problem (scored
    // elsewhere), not evidence of concentration — neutral, not zero/full.
    institutionConcentration = 2
    institutionalBreadth = 1.5
    institutionNote = 'insufficient affiliation metadata (<30% of authors) — neutral default, not a concentration signal'
  } else {
    const normalizedAff = affiliations.map(normalizeAffiliation)
    const counts = new Map()
    for (const n of normalizedAff) counts.set(n, (counts.get(n) ?? 0) + 1)
    const maxShare = Math.max(...counts.values()) / normalizedAff.length
    const uniqueRatio = counts.size / normalizedAff.length
    institutionConcentration = tierInstitutionConcentration(maxShare)
    institutionalBreadth = uniqueRatio >= 0.6 ? 3 : uniqueRatio >= 0.3 ? 2 : 1
    institutionNote = `largest-institution share ${(maxShare * 100).toFixed(1)}%, unique-institution ratio ${(uniqueRatio * 100).toFixed(1)}%`
  }

  // Recurrent Author Concentration (3) — ORCID/name identity ONLY, never
  // affiliation (see resolveAuthorIdentity()).
  const authorIdentities = articles.flatMap(a => a.authors.map(resolveAuthorIdentity).filter(Boolean))
  let recurrentAuthorConcentration, authorNote
  if (authorIdentities.length === 0) {
    recurrentAuthorConcentration = 1.5 // neutral default — no identifiable authors at all is a completeness gap, not a concentration finding
    authorNote = 'no author had a resolvable ORCID or full given+family name — neutral default'
  } else {
    const authorCounts = new Map()
    for (const id of authorIdentities) authorCounts.set(id, (authorCounts.get(id) ?? 0) + 1)
    // Share is of ARTICLES (not raw author-slots), matching the framework's
    // "largest-institution share" framing for the parallel institution check.
    const maxAuthorArticleShare = Math.max(...authorCounts.values()) / articles.length
    recurrentAuthorConcentration = tierAuthorConcentration(maxAuthorArticleShare)
    authorNote = `most-recurrent identifiable author appears in ${(maxAuthorArticleShare * 100).toFixed(1)}% of sampled articles`
  }

  const total = round2(institutionConcentration + recurrentAuthorConcentration + institutionalBreadth)

  return {
    score: clamp(total, REACH_CONCENTRATION_WEIGHT),
    subfactors: {
      institution_concentration: institutionConcentration,
      recurrent_author_concentration: recurrentAuthorConcentration,
      institutional_breadth: institutionalBreadth,
    },
    notes: { institution: institutionNote, author: authorNote },
  }
}

// ---------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------

function round2(n) { return Math.round(n * 100) / 100 }

/**
 * Combines all 7 dimensions into the AJR-E 1.1 total (100 points).
 * Callers are expected to have already gated eligibility (evidence
 * coverage thresholds, mandatory evidence, lifecycle stage) before calling
 * this — see evidence-coverage.mjs's ratingEligibility() for that gate,
 * which this function does not itself apply.
 *
 * @param {{
 *   editorialGovernance: Object<string,string>,
 *   researchIntegrity: Object<string,string>,
 *   infrastructure: Object<string,string>,
 *   publishingStability: { evidence: object, cadence: object, continuity: object, output: object },
 *   articles: Parameters<typeof scoreOutputSignals>[0],
 *   transparency: Object<string,string>,
 * }} input
 */
export function computeAjrE(input) {
  const egf = scoreEditorialGovernance(input.editorialGovernance)
  const rif = scoreResearchIntegrity(input.researchIntegrity)
  const inf = scoreInfrastructure(input.infrastructure)
  const pub = scorePublishingStability(input.publishingStability.evidence, input.publishingStability.cadence, input.publishingStability.continuity, input.publishingStability.output)
  const soc = scoreOutputSignals(input.articles)
  const rdc = scoreReachConcentration(input.articles)
  const trn = scoreTransparency(input.transparency)

  const total = round2(egf.score + rif.score + inf.score + pub.score + soc.score + rdc.score + trn.score)

  return {
    subfactors: { egf, rif, inf, pub, soc, rdc, trn },
    total,
    methodology_version: AJR_E_METHODOLOGY_VERSION,
  }
}
