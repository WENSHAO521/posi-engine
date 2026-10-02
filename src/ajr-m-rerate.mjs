/**
 * AJR-M-1.1 rerate pipeline — the AJR-M counterpart of `ajr-e-rerate.mjs`.
 * `ajr-mature.mjs` scores already-resolved inputs (percentiles, yearly
 * output, one status per evidence item); this module resolves those inputs
 * from the data posi-data actually holds, applies the eligibility gate
 * (`evidence-coverage.mjs#ratingEligibility()`) and the citation-integrity
 * gate (`gateAjrMByIntegrity()`), and returns a rating snapshot in
 * posi-data's `schema/rating.schema.json` shape (track `mature`).
 *
 * Inputs and where they come from:
 *   - Dimension 1 (citation): PNCI and the ranking category from the
 *     Citation Ranking edition (`rankings/citation/`), PCI/PCI-5 from the
 *     PCI audit (`collections/pci.json`); see buildCitationPeerSets().
 *   - Dimension 2 (output): yearly work counts for the last 5 complete
 *     years (posi-data `evidence/output/`, fetched from OpenAlex by
 *     run-output-history-etl.mjs), the
 *     Article-Sample ETL's cadence and deposit timeliness, and two statuses
 *     derived from the article sample with AJR-E's own field set and rule.
 *   - Dimensions 3/4/6 (evidence): the site-crawl and Article-Sample
 *     evidence items AJR-E already uses, mapped onto AJR-M's items by
 *     GOVERNANCE_EVIDENCE_MAP / INFRASTRUCTURE_EVIDENCE_MAP.
 *   - Dimension 5 (reach): author and institution shares from the article
 *     sample, same identity rules as AJR-E. Citing-source concentration has
 *     no data source yet and takes ajr-mature.mjs's neutral default.
 *
 * Pure functions only — no I/O (see `scripts/rate-mature.mjs`).
 */

import { classifyLifecycle } from './lifecycle.mjs'
import { computeAjrM, gateAjrMByIntegrity, computeCitationPercentiles, AJR_M_METHODOLOGY_VERSION } from './ajr-mature.mjs'
import {
  EDITORIAL_GOVERNANCE_ITEMS, RESEARCH_INTEGRITY_ITEMS, MIN_ARTICLE_SAMPLE_SIZE,
  resolveAuthorIdentity, normalizeAffiliation,
} from './ajr-early-stage.mjs'
import { ratingEligibility, EC_PROVISIONAL_THRESHOLD } from './evidence-coverage.mjs'
import { getAJRRating, AJR_RATING_VERSION } from './evaluation.mjs'
import { MIN_CATEGORY_SIZE } from './ranking.mjs'
import { itemStatusMap } from './ajr-e-rerate.mjs'

function round2(n) { return Math.round(n * 100) / 100 }

// ---------------------------------------------------------------------
// Evidence item mapping (Dimensions 3 and 4)
// ---------------------------------------------------------------------

/**
 * AJR-M item -> the site-crawl evidence items (AJR-E-1.1 ids) it is made of.
 * JUDGMENT CALL (flagged): AJR-M-1.0-SPEC.md § 4 names six items but the
 * crawl resolves AJR-E's finer-grained ones; every AJR-E governance and
 * integrity item is used exactly once.
 */
export const GOVERNANCE_EVIDENCE_MAP = Object.freeze({
  editorial_governance: ['aims_scope_explicit', 'editorial_board_public', 'editor_identity_affiliation_verifiable'],
  peer_review_transparency: ['peer_review_process_disclosed', 'reviewer_editorial_guidelines'],
  retraction_correction_integrity_framework: ['corrections_retractions_policy', 'publication_ethics_policy', 'plagiarism_similarity_policy', 'complaints_appeals'],
  authorship_coi: ['authorship_contributorship_policy', 'conflict_of_interest_policy'],
  research_data_ethics: ['human_animal_ethics_consent', 'data_availability_sharing'],
  ai_policy: ['ai_use_policy'],
})

/**
 * AJR-M item -> the Article-Sample ETL infrastructure items it is made of.
 * `stable_urls_https` has no evidence source yet: it stays `unknown`, which
 * lowers Evidence Coverage but never scores as failed.
 */
export const INFRASTRUCTURE_EVIDENCE_MAP = Object.freeze({
  doi_reliability: ['doi_resolution_reliability'],
  metadata_completeness: ['crossref_metadata_completeness'],
  structured_harvesting: ['oai_pmh_schema_org_machine_readable'],
  reference_metadata: ['abstract_reference_license_metadata'],
  long_term_preservation: ['digital_preservation_archiving'],
  stable_urls_https: [],
})

const UNRESOLVED_PRIORITY = ['conflicted', 'blocked', 'stale', 'unknown']

/**
 * One status for an AJR-M item made of several evidence items. Each AJR-M
 * item is a composite requirement ("Authorship/COI" needs both policies),
 * so it is `met` only when every applicable part is met, and `not_met` as
 * soon as one resolved part is not met. Otherwise it is unresolved, taking
 * the most specific unresolved status among its parts.
 * @param {string[]} statuses
 */
export function mergeStatuses(statuses) {
  if (statuses.length === 0) return 'unknown'
  const applicable = statuses.filter(s => s !== 'not_applicable')
  if (applicable.length === 0) return 'not_applicable'
  if (applicable.includes('not_met')) return 'not_met'
  if (applicable.every(s => s === 'met')) return 'met'
  return UNRESOLVED_PRIORITY.find(s => applicable.includes(s)) ?? 'unknown'
}

/**
 * @param {Object<string,string[]>} map
 * @param {Object<string,string>} sourceStatuses - evidence id -> status
 * @returns {Object<string,string>} AJR-M item id -> status
 */
export function mapItemStatuses(map, sourceStatuses) {
  return Object.fromEntries(Object.entries(map).map(([id, sources]) =>
    [id, mergeStatuses(sources.map(s => sourceStatuses[s] ?? 'unknown'))]))
}

// ---------------------------------------------------------------------
// Article-sample derived inputs (Dimensions 2 and 5)
// ---------------------------------------------------------------------

/**
 * JUDGMENT CALL (flagged): the share of AJR-E's structural fields (abstract,
 * references, affiliation, ORCID, licence — scoreOutputSignals()) present
 * on average across the sample, `met` at 80% or more. `unknown` below the
 * minimum sample size.
 */
export const STRUCTURAL_METADATA_MET_SHARE = 0.8

export function structuralMetadataStatus(articles) {
  if (!articles || articles.length < MIN_ARTICLE_SAMPLE_SIZE) return 'unknown'
  let sum = 0
  for (const a of articles) {
    const fields = [a.hasAbstract, a.referenceCount > 0, a.authors.some(x => x.affiliation), a.authors.some(x => x.orcid), a.hasLicense]
    sum += fields.filter(Boolean).length / fields.length
  }
  return sum / articles.length >= STRUCTURAL_METADATA_MET_SHARE ? 'met' : 'not_met'
}

/**
 * AJR-E's date-pattern rule (scoreOutputSignals()): five or more dated
 * articles all on one date is a batch dump. Fewer than five dated articles
 * cannot show either way.
 */
export function dateConsistencyStatus(articles) {
  const dates = (articles ?? []).map(a => a.publishedDate).filter(Boolean)
  if (dates.length < 5) return 'unknown'
  return new Set(dates).size === 1 ? 'not_met' : 'met'
}

/**
 * Author and institution shares for scoreReachConcentrationMature(), with
 * AJR-E's identity rules (ORCID or full name for authors, never
 * affiliation; institution shares only when at least 30% of authors carry
 * an affiliation, else null = the module's neutral default).
 */
export function reachInputs(articles) {
  const list = articles ?? []
  const totalAuthors = list.reduce((s, a) => s + a.authors.length, 0)
  const affiliations = list.flatMap(a => a.authors.map(au => au.affiliation).filter(Boolean)).map(normalizeAffiliation)
  let maxInstitutionShare = null, uniqueInstitutionRatio = null
  if (totalAuthors > 0 && affiliations.length / totalAuthors >= 0.3) {
    const counts = new Map()
    for (const n of affiliations) counts.set(n, (counts.get(n) ?? 0) + 1)
    maxInstitutionShare = round2(Math.max(...counts.values()) / affiliations.length)
    uniqueInstitutionRatio = round2(counts.size / affiliations.length)
  }
  const authorCounts = new Map()
  for (const a of list) {
    for (const id of new Set(a.authors.map(resolveAuthorIdentity).filter(Boolean))) authorCounts.set(id, (authorCounts.get(id) ?? 0) + 1)
  }
  const maxAuthorShare = authorCounts.size > 0 ? round2(Math.max(...authorCounts.values()) / list.length) : null
  return { maxAuthorShare, maxInstitutionShare, uniqueInstitutionRatio, maxCitingSourceShare: null }
}

// ---------------------------------------------------------------------
// Output history (Dimension 2)
// ---------------------------------------------------------------------

/**
 * The last five complete calendar years before the rating date.
 * @param {Date} ratingDate
 */
export function outputYears(ratingDate) {
  const y = ratingDate.getUTCFullYear()
  return [y - 5, y - 4, y - 3, y - 2, y - 1]
}

/**
 * @param {Object<string,number>|null} countsByYear - year -> works that year
 *   (a year missing from the map published nothing)
 * @param {number[]} years
 * @returns {{ continuity5yr: boolean[], annualOutputCounts: number[] } | null}
 */
export function outputHistoryInputs(countsByYear, years) {
  if (!countsByYear) return null
  const counts = years.map(y => countsByYear[y] ?? 0)
  return { continuity5yr: counts.map(n => n > 0), annualOutputCounts: counts }
}

// ---------------------------------------------------------------------
// Citation percentiles (Dimension 1)
// ---------------------------------------------------------------------

/**
 * Peer sets per ranking category for computeCitationPercentiles().
 * PNCI peers are the journals the Citation Ranking edition ranked
 * (official or provisional) in that category; PCI/PCI-5 peers are every
 * journal with a PCI value whose ranking category is that category.
 * @param {{ journal_id: string, pnci: number|null, ranking_category_id: string|null, citation_ranking_status: string }[]} rankingRecords
 * @param {{ journal_id: string, pci: number|null, pci_5yr: number|null }[]} pciRecords
 * @returns {{ categoryOf: Map<string,string>, pnci: Map<string,object[]>, pci: Map<string,object[]> }}
 */
export function buildCitationPeerSets(rankingRecords, pciRecords) {
  const categoryOf = new Map()
  const pnci = new Map()
  for (const r of rankingRecords) {
    if (!r.ranking_category_id) continue
    categoryOf.set(r.journal_id, r.ranking_category_id)
    if (r.pnci == null || !['official', 'provisional'].includes(r.citation_ranking_status)) continue
    if (!pnci.has(r.ranking_category_id)) pnci.set(r.ranking_category_id, [])
    pnci.get(r.ranking_category_id).push({ journal_id: r.journal_id, pci: null, pci_5yr: null, pnci: r.pnci })
  }
  const pci = new Map()
  for (const r of pciRecords) {
    const cat = categoryOf.get(r.journal_id)
    if (!cat || (r.pci == null && r.pci_5yr == null)) continue
    if (!pci.has(cat)) pci.set(cat, [])
    pci.get(cat).push({ journal_id: r.journal_id, pci: r.pci, pci_5yr: r.pci_5yr, pnci: null })
  }
  return { categoryOf, pnci, pci }
}

/**
 * Within-category percentiles, each null when its peer set is smaller than
 * MIN_CATEGORY_SIZE (the same minimum the Citation Ranking uses) — a
 * percentile among a handful of journals says nothing.
 */
export function citationPercentilesFor(peerSets, journalId) {
  const cat = peerSets.categoryOf.get(journalId) ?? null
  const pick = (peers, field) => {
    if (!peers || peers.filter(p => p[field] != null).length < MIN_CATEGORY_SIZE) return null
    return computeCitationPercentiles(peers, journalId)[`percentile_${field === 'pci_5yr' ? 'pci5' : field}`]
  }
  const pciPeers = cat ? peerSets.pci.get(cat) : null
  return {
    category: cat,
    percentiles: {
      percentile_pci: pick(pciPeers, 'pci'),
      percentile_pci5: pick(pciPeers, 'pci_5yr'),
      percentile_pnci: pick(cat ? peerSets.pnci.get(cat) : null, 'pnci'),
    },
  }
}

// ---------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------

/** Evidence Coverage over every evidence-backed item AJR-M scores. */
export function aggregateAjrMCoverage(ajrM) {
  const s = ajrM.subfactors
  const parts = [
    s.governance.coverage, s.infrastructure.coverage, s.transparency.coverage,
    s.output.subfactors.structural_metadata_quality.coverage,
    s.output.subfactors.deposit_timeliness.coverage,
    s.output.subfactors.date_consistency.coverage,
  ]
  const applicable = parts.reduce((sum, c) => sum + c.applicable_weight, 0)
  const resolved = parts.reduce((sum, c) => sum + c.resolved_weight, 0)
  return applicable > 0 ? round2((resolved / applicable) * 100) : 0
}

export function determineMandatoryEvidenceResolvedM({ hasIssn, lifecycleStage, sampleSize, category, outputHistory }) {
  const reasons = []
  if (!hasIssn) reasons.push('no ISSN on record')
  if (lifecycleStage !== 'mature') reasons.push(`lifecycle stage is '${lifecycleStage}', not mature`)
  if (sampleSize < MIN_ARTICLE_SAMPLE_SIZE) reasons.push(`article sample of ${sampleSize} is below the minimum of ${MIN_ARTICLE_SAMPLE_SIZE}`)
  if (!category) reasons.push('no ranking category (journal not in the Citation Ranking edition)')
  if (!outputHistory) reasons.push('no yearly output history')
  return { resolved: reasons.length === 0, reasons }
}

/**
 * @param {{
 *   journal: { posi_id: string, issn_online: string|null, issn_print: string|null, early_stage_rating?: { first_published: string|null } },
 *   journalEvidence: { evidence_items: { id: string, status: string }[] } | null,
 *   worksEvidence: object | null,
 *   peerSets: ReturnType<typeof buildCitationPeerSets>,
 *   countsByYear: Object<string,number> | null,
 *   integrityVerdict?: { flagged: boolean, flagged_checks?: string[] } | null,
 *   ratingDate: Date,
 * }} input
 * @returns {{ rating: object|null, lifecycle_stage: string, reasons: string[] }}
 *   `rating` is null for a journal that is not Mature (AJR-M does not apply);
 *   otherwise a rating.schema.json record.
 */
export function rateMatureJournal({ journal, journalEvidence, worksEvidence, peerSets, countsByYear, integrityVerdict = null, ratingDate }) {
  const lifecycle = classifyLifecycle(journal.early_stage_rating?.first_published ?? null, ratingDate)
  if (lifecycle.lifecycle_stage !== 'mature') return { rating: null, lifecycle_stage: lifecycle.lifecycle_stage, reasons: [] }

  const ratedAt = ratingDate.toISOString().slice(0, 10)
  const articles = worksEvidence?.article_sample ?? []
  const siteStatuses = itemStatusMap(journalEvidence?.evidence_items ?? [])
  const { category, percentiles } = citationPercentilesFor(peerSets, journal.posi_id)
  const outputHistory = outputHistoryInputs(countsByYear, outputYears(ratingDate))

  const ajrM = computeAjrM({
    citationPercentiles: percentiles,
    outputStability: {
      continuity5yr: outputHistory?.continuity5yr ?? [],
      annualOutputCounts: outputHistory?.annualOutputCounts ?? [],
      schedule: worksEvidence?.publishing_stability?.cadence ?? {},
      structuralMetadataStatus: structuralMetadataStatus(articles),
      depositTimelinessStatus: worksEvidence?.publishing_stability?.deposit_timeliness ?? 'unknown',
      dateConsistencyStatus: dateConsistencyStatus(articles),
    },
    governanceIntegrity: mapItemStatuses(GOVERNANCE_EVIDENCE_MAP, siteStatuses),
    infrastructure: mapItemStatuses(INFRASTRUCTURE_EVIDENCE_MAP, worksEvidence?.infrastructure_item_statuses ?? {}),
    reachConcentration: reachInputs(articles),
    transparency: siteStatuses,
  })

  const coverage = aggregateAjrMCoverage(ajrM)
  const mandatory = determineMandatoryEvidenceResolvedM({
    hasIssn: Boolean(journal.issn_online || journal.issn_print),
    lifecycleStage: lifecycle.lifecycle_stage,
    sampleSize: articles.length,
    category,
    outputHistory,
  })
  let status = ratingEligibility(coverage, mandatory.resolved)
  const reasons = [...mandatory.reasons]
  if (status === 'not_rateable' && mandatory.resolved) reasons.push(`evidence coverage ${coverage}% is below the not-rateable threshold of ${EC_PROVISIONAL_THRESHOLD}%`)

  let suppressionReason = null
  if (status !== 'not_rateable') {
    const gated = gateAjrMByIntegrity(ajrM, integrityVerdict)
    if (gated.status === 'not_officially_rankable') {
      status = 'not_officially_rankable'
      suppressionReason = gated.flagged_checks.join('; ') || gated.reason
      reasons.push(`citation integrity suppression: ${suppressionReason}`)
    }
  }

  const scored = status === 'official' || status === 'provisional'
  const s = ajrM.subfactors
  return {
    lifecycle_stage: lifecycle.lifecycle_stage,
    reasons,
    rating: {
      journal_id: journal.posi_id,
      track: 'mature',
      rating_date: ratedAt,
      methodology_version: AJR_M_METHODOLOGY_VERSION,
      rating_status: status,
      suppression_reason: suppressionReason,
      total_score: scored ? ajrM.total : null,
      rating: scored ? getAJRRating(ajrM.total) : null,
      rating_version: AJR_RATING_VERSION,
      evidence_coverage_percent: coverage,
      dimensions: scored ? {
        citation: { score: s.citation.score, computable_max: s.citation.computable_max, category, ...percentiles },
        output: { score: s.output.score, ...(outputHistory ?? {}) },
        governance: { score: s.governance.score },
        infrastructure: { score: s.infrastructure.score },
        reach: { score: s.reach.score, ...s.reach.subfactors },
        transparency: { score: s.transparency.score },
      } : null,
      pjr_release: null,
    },
  }
}
