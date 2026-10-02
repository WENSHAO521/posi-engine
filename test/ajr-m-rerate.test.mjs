import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOVERNANCE_EVIDENCE_MAP, INFRASTRUCTURE_EVIDENCE_MAP, mergeStatuses, mapItemStatuses,
  structuralMetadataStatus, dateConsistencyStatus, reachInputs, outputYears, outputHistoryInputs,
  buildCitationPeerSets, citationPercentilesFor, rateMatureJournal,
} from '../src/ajr-m-rerate.mjs'
import { GOVERNANCE_INTEGRITY_ITEMS, AJRM_INFRASTRUCTURE_ITEMS } from '../src/ajr-mature.mjs'
import { EDITORIAL_GOVERNANCE_ITEMS, RESEARCH_INTEGRITY_ITEMS, INFRASTRUCTURE_ITEMS } from '../src/ajr-early-stage.mjs'
import { TRANSPARENCY_ITEMS } from '../src/shared-dimensions.mjs'
import { fetchCountsByYear } from '../src/output-history.mjs'

const RATING_DATE = new Date('2026-10-07T00:00:00Z')

// --- evidence mapping contract -----------------------------------------

test('GOVERNANCE_EVIDENCE_MAP: covers exactly the AJR-M items, and every AJR-E governance/integrity item once', () => {
  assert.deepEqual(Object.keys(GOVERNANCE_EVIDENCE_MAP).sort(), GOVERNANCE_INTEGRITY_ITEMS.map(i => i.id).sort())
  const sources = Object.values(GOVERNANCE_EVIDENCE_MAP).flat().sort()
  assert.deepEqual(sources, [...EDITORIAL_GOVERNANCE_ITEMS, ...RESEARCH_INTEGRITY_ITEMS].map(i => i.id).sort())
})

test('INFRASTRUCTURE_EVIDENCE_MAP: covers exactly the AJR-M items, and only maps real Article-Sample ids', () => {
  assert.deepEqual(Object.keys(INFRASTRUCTURE_EVIDENCE_MAP).sort(), AJRM_INFRASTRUCTURE_ITEMS.map(i => i.id).sort())
  const known = new Set(INFRASTRUCTURE_ITEMS.map(i => i.id))
  for (const s of Object.values(INFRASTRUCTURE_EVIDENCE_MAP).flat()) assert.ok(known.has(s), s)
})

test('mergeStatuses: met only when every applicable part is met; any not_met fails the item', () => {
  assert.equal(mergeStatuses(['met', 'met']), 'met')
  assert.equal(mergeStatuses(['met', 'not_met']), 'not_met')
  assert.equal(mergeStatuses(['unknown', 'not_met']), 'not_met')
  assert.equal(mergeStatuses(['met', 'not_applicable']), 'met')
})

test('mergeStatuses: unresolved parts leave the item unresolved, never failed', () => {
  assert.equal(mergeStatuses(['met', 'unknown']), 'unknown')
  assert.equal(mergeStatuses(['met', 'blocked', 'unknown']), 'blocked')
  assert.equal(mergeStatuses(['not_applicable', 'not_applicable']), 'not_applicable')
  assert.equal(mergeStatuses([]), 'unknown')
})

test('mapItemStatuses: an AJR-M item with no evidence source stays unknown', () => {
  const out = mapItemStatuses(INFRASTRUCTURE_EVIDENCE_MAP, { doi_resolution_reliability: 'met' })
  assert.equal(out.doi_reliability, 'met')
  assert.equal(out.stable_urls_https, 'unknown')
})

// --- article sample ------------------------------------------------------

function article(over = {}) {
  return {
    title: 'A study', hasAbstract: true, referenceCount: 20, hasLicense: true, documentType: 'journal-article',
    publishedDate: '2025-01-01', issueOrPeriod: 'v1i1',
    authors: [{ affiliation: 'Univ A', orcid: '0000-0001', given_name: 'A', family_name: 'One' }],
    ...over,
  }
}

function sample(n, f = i => ({})) {
  return Array.from({ length: n }, (_, i) => article({ publishedDate: `2025-01-${String(1 + (i % 28)).padStart(2, '0')}`, ...f(i) }))
}

test('structuralMetadataStatus: unknown below the minimum sample, met/not_met on the 80% share', () => {
  assert.equal(structuralMetadataStatus(sample(5)), 'unknown')
  assert.equal(structuralMetadataStatus(sample(10)), 'met')
  assert.equal(structuralMetadataStatus(sample(10, () => ({ hasAbstract: false, hasLicense: false }))), 'not_met')
})

test('dateConsistencyStatus: AJR-E batch-dump rule', () => {
  assert.equal(dateConsistencyStatus(sample(4)), 'unknown')
  assert.equal(dateConsistencyStatus(sample(6)), 'met')
  assert.equal(dateConsistencyStatus(sample(6, () => ({ publishedDate: '2025-03-03' }))), 'not_met')
})

test('reachInputs: author share per article, institution shares only with enough affiliations', () => {
  const r = reachInputs(sample(10, i => ({ authors: [{ affiliation: `Univ ${i % 2}`, orcid: `0000-${i}` }] })))
  assert.equal(r.maxAuthorShare, 0.1)
  assert.equal(r.maxInstitutionShare, 0.5)
  assert.equal(r.uniqueInstitutionRatio, 0.2)
  assert.equal(r.maxCitingSourceShare, null)
  const sparse = reachInputs(sample(10, () => ({ authors: [{ affiliation: null, orcid: '0000-1' }] })))
  assert.equal(sparse.maxInstitutionShare, null)
  assert.equal(sparse.maxAuthorShare, 1)
})

// --- output history ------------------------------------------------------

test('outputYears: the five complete years before the rating date', () => {
  assert.deepEqual(outputYears(RATING_DATE), [2021, 2022, 2023, 2024, 2025])
})

test('outputHistoryInputs: a missing year published nothing; no data at all is null, not zeros', () => {
  const h = outputHistoryInputs({ 2021: 10, 2022: 12, 2024: 9, 2025: 11 }, outputYears(RATING_DATE))
  assert.deepEqual(h.annualOutputCounts, [10, 12, 0, 9, 11])
  assert.deepEqual(h.continuity5yr, [true, true, false, true, true])
  assert.equal(outputHistoryInputs(null, outputYears(RATING_DATE)), null)
})

// --- citation percentiles ------------------------------------------------

function rankingRecords(cat, n, statusOf = () => 'official') {
  return Array.from({ length: n }, (_, i) => ({ journal_id: `POSI-J-${String(i + 1).padStart(6, '0')}`, pnci: i + 1, ranking_category_id: cat, citation_ranking_status: statusOf(i) }))
}

test('citationPercentilesFor: within-category percentiles from ranked peers', () => {
  const ranking = rankingRecords('P1.01', 20)
  const pci = ranking.map((r, i) => ({ journal_id: r.journal_id, pci: i + 1, pci_5yr: null }))
  const peers = buildCitationPeerSets(ranking, pci)
  const top = citationPercentilesFor(peers, 'POSI-J-000020')
  assert.equal(top.category, 'P1.01')
  assert.equal(top.percentiles.percentile_pnci, 97.5)
  assert.equal(top.percentiles.percentile_pci, 97.5)
  assert.equal(top.percentiles.percentile_pci5, null)
})

test('citationPercentilesFor: a peer set below MIN_CATEGORY_SIZE gives no percentile', () => {
  const peers = buildCitationPeerSets(rankingRecords('P1.01', 19), [])
  assert.equal(citationPercentilesFor(peers, 'POSI-J-000001').percentiles.percentile_pnci, null)
})

test('citationPercentilesFor: unranked journals are not PNCI peers, and get no PNCI percentile', () => {
  const ranking = rankingRecords('P1.01', 25, i => (i === 0 ? 'not_available' : 'official'))
  const peers = buildCitationPeerSets(ranking, [])
  assert.equal(peers.pnci.get('P1.01').length, 24)
  assert.equal(citationPercentilesFor(peers, 'POSI-J-000001').percentiles.percentile_pnci, null)
  assert.equal(citationPercentilesFor(peers, 'POSI-J-000001').category, 'P1.01')
})

// --- rateMatureJournal ---------------------------------------------------

const ALL_SITE_MET = [...EDITORIAL_GOVERNANCE_ITEMS, ...RESEARCH_INTEGRITY_ITEMS, ...TRANSPARENCY_ITEMS].map(i => ({ id: i.id, status: 'met' }))
const ALL_INFRA_MET = Object.fromEntries(INFRASTRUCTURE_ITEMS.map(i => [i.id, 'met']))

function matureInput(over = {}) {
  const ranking = rankingRecords('P1.01', 30)
  return {
    journal: { posi_id: 'POSI-J-000030', title: 'Old Journal', issn_online: '1234-5678', issn_print: null, early_stage_rating: { first_published: '1990-01-01' } },
    journalEvidence: { evidence_items: ALL_SITE_MET },
    worksEvidence: {
      article_sample: sample(30, i => ({ authors: [{ affiliation: `Univ ${i}`, orcid: `0000-${i}` }] })),
      infrastructure_item_statuses: ALL_INFRA_MET,
      publishing_stability: { cadence: { expectedWindows: 10, metWindows: 10 }, deposit_timeliness: 'met' },
    },
    peerSets: buildCitationPeerSets(ranking, ranking.map((r, i) => ({ journal_id: r.journal_id, pci: i, pci_5yr: i }))),
    countsByYear: { 2021: 50, 2022: 50, 2023: 50, 2024: 50, 2025: 50 },
    ratingDate: RATING_DATE,
    ...over,
  }
}

test('rateMatureJournal: not Mature -> no rating at all (AJR-M does not apply)', () => {
  const r = rateMatureJournal(matureInput({ journal: { posi_id: 'POSI-J-000001', issn_online: 'x', early_stage_rating: { first_published: '2024-01-01' } } }))
  assert.equal(r.rating, null)
  assert.equal(r.lifecycle_stage, 'early_stage')
})

test('rateMatureJournal: full evidence -> official, scored, rating.schema.json shape', () => {
  const { rating, reasons } = rateMatureJournal(matureInput())
  assert.equal(rating.rating_status, 'official')
  assert.equal(rating.track, 'mature')
  assert.equal(rating.methodology_version, 'AJR-M-1.0')
  assert.equal(rating.rating_date, '2026-10-07')
  assert.ok(rating.total_score > 90, String(rating.total_score))
  assert.equal(rating.rating, 'A+')
  assert.equal(rating.dimensions.citation.category, 'P1.01')
  assert.deepEqual(rating.dimensions.output.annualOutputCounts, [50, 50, 50, 50, 50])
  assert.deepEqual(reasons, [])
  assert.deepEqual(Object.keys(rating).sort(), [
    'dimensions', 'evidence_coverage_percent', 'journal_id', 'methodology_version', 'pjr_release', 'rating',
    'rating_date', 'rating_status', 'rating_version', 'suppression_reason', 'total_score', 'track',
  ])
})

test('rateMatureJournal: no evidence at all -> not_rateable with the reasons, never a 0 score', () => {
  const { rating, reasons } = rateMatureJournal(matureInput({ journalEvidence: null, worksEvidence: null, countsByYear: null }))
  assert.equal(rating.rating_status, 'not_rateable')
  assert.equal(rating.total_score, null)
  assert.equal(rating.rating, null)
  assert.equal(rating.dimensions, null)
  assert.ok(reasons.some(r => r.includes('article sample')))
  assert.ok(reasons.some(r => r.includes('output history')))
})

test('rateMatureJournal: journal outside the Citation Ranking is not rateable', () => {
  const input = matureInput()
  input.journal = { ...input.journal, posi_id: 'POSI-J-999999' }
  const { rating, reasons } = rateMatureJournal(input)
  assert.equal(rating.rating_status, 'not_rateable')
  assert.ok(reasons.some(r => r.includes('ranking category')))
})

test('rateMatureJournal: a confirmed suppression replaces the whole result, never a deduction', () => {
  const { rating } = rateMatureJournal(matureInput({ integrityVerdict: { flagged: true, flagged_checks: ['citation_stacking'] } }))
  assert.equal(rating.rating_status, 'not_officially_rankable')
  assert.equal(rating.suppression_reason, 'citation_stacking')
  assert.equal(rating.total_score, null)
  assert.equal(rating.rating, null)
})

// --- output-history.mjs --------------------------------------------------

test('fetchCountsByYear: year -> works_count from the OpenAlex source record', async () => {
  let url
  const fetchImpl = async u => { url = u; return { ok: true, status: 200, json: async () => ({ counts_by_year: [{ year: 2025, works_count: 40 }, { year: 2024, works_count: 38 }] }) } }
  const r = await fetchCountsByYear('https://openalex.org/S123', { fetchImpl })
  assert.ok(url.includes('/sources/S123?select=counts_by_year'))
  assert.deepEqual(r, { counts_by_year: { 2024: 38, 2025: 40 }, error: null })
})

test('fetchCountsByYear: a failed request is null with the reason, never an empty history', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 })
  assert.deepEqual(await fetchCountsByYear('S1', { fetchImpl, maxAttempts: 1 }), { counts_by_year: null, error: 'HTTP 403' })
  assert.deepEqual(await fetchCountsByYear(null, { fetchImpl }), { counts_by_year: null, error: 'no OpenAlex source id' })
})
