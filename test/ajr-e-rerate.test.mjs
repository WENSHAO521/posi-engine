import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  itemStatusMap, aggregateOverallEvidenceCoverage, determineMandatoryEvidenceResolved, rateJournal,
} from '../src/ajr-e-rerate.mjs'
import { computeAjrE, EDITORIAL_GOVERNANCE_ITEMS, RESEARCH_INTEGRITY_ITEMS, INFRASTRUCTURE_ITEMS } from '../src/ajr-early-stage.mjs'
import { TRANSPARENCY_ITEMS } from '../src/shared-dimensions.mjs'

test('itemStatusMap: array of {id,status} -> object keyed by id', () => {
  const map = itemStatusMap([{ id: 'a', status: 'met' }, { id: 'b', status: 'not_met' }])
  assert.deepEqual(map, { a: 'met', b: 'not_met' })
})

test('itemStatusMap: empty/undefined input -> empty object, never throws', () => {
  assert.deepEqual(itemStatusMap([]), {})
  assert.deepEqual(itemStatusMap(undefined), {})
})

// --- aggregateOverallEvidenceCoverage --------------------------------

function fullyMetItemStatuses(items) {
  return Object.fromEntries(items.map(i => [i.id, 'met']))
}

const ALL_MET_SITE_ITEMS = {
  ...fullyMetItemStatuses(EDITORIAL_GOVERNANCE_ITEMS),
  ...fullyMetItemStatuses(RESEARCH_INTEGRITY_ITEMS),
  ...fullyMetItemStatuses(TRANSPARENCY_ITEMS),
}
const ALL_MET_INFRA = fullyMetItemStatuses(INFRASTRUCTURE_ITEMS)

function realArticle(i, opts = {}) {
  return {
    title: `Article ${i}`, hasAbstract: true, referenceCount: 20, hasLicense: true,
    documentType: 'journal-article', publishedDate: `2025-0${(i % 9) + 1}-15`,
    issueOrPeriod: `v1i${(i % 3) + 1}`,
    authors: [{ affiliation: 'Some University', orcid: `000${i}-0000-0000-000${i}`, given_name: `Given${i}`, family_name: `Family${i}` }],
    ...opts,
  }
}
const RICH_ARTICLES = Array.from({ length: 30 }, (_, i) => realArticle(i))

function baseAjrEInput() {
  return {
    editorialGovernance: ALL_MET_SITE_ITEMS,
    researchIntegrity: ALL_MET_SITE_ITEMS,
    infrastructure: ALL_MET_INFRA,
    publishingStability: {
      evidence: { frequency_disclosed: 'unknown', deposit_timeliness: 'met' },
      cadence: { expectedWindows: 10, metWindows: 9 },
      continuity: { totalWindows: 6, activeWindows: 6 },
      output: { articleCount: 30, monthsSinceLaunch: 20 },
    },
    articles: RICH_ARTICLES,
    transparency: ALL_MET_SITE_ITEMS,
  }
}

test('aggregateOverallEvidenceCoverage: all evidence-item dimensions fully met, frequency_disclosed unresolved -> high but not 100% coverage', () => {
  const ajrE = computeAjrE(baseAjrEInput())
  const coverage = aggregateOverallEvidenceCoverage(ajrE)
  assert.ok(coverage.coverage_percent < 100, 'frequency_disclosed is always unknown in this pipeline -- must cap coverage below 100%')
  assert.ok(coverage.coverage_percent >= 80, 'a single always-unknown 2-weight item out of ~59 must not drag coverage below the official threshold')
})

test('aggregateOverallEvidenceCoverage: everything unknown -> 0% (not NaN, not a crash)', () => {
  const ajrE = computeAjrE({
    editorialGovernance: {}, researchIntegrity: {}, infrastructure: {},
    publishingStability: { evidence: {}, cadence: { expectedWindows: 0, metWindows: 0 }, continuity: { totalWindows: 0, activeWindows: 0 }, output: { articleCount: 0, monthsSinceLaunch: null } },
    articles: [], transparency: {},
  })
  const coverage = aggregateOverallEvidenceCoverage(ajrE)
  assert.equal(coverage.coverage_percent, 0)
})

test('aggregateOverallEvidenceCoverage: does not fold in Dimension 5/6 or cadence/continuity -- a bad article sample does not change coverage%', () => {
  const richInput = baseAjrEInput()
  const noArticlesInput = { ...richInput, articles: [] }
  const richCoverage = aggregateOverallEvidenceCoverage(computeAjrE(richInput))
  const noArticlesCoverage = aggregateOverallEvidenceCoverage(computeAjrE(noArticlesInput))
  assert.equal(richCoverage.coverage_percent, noArticlesCoverage.coverage_percent, 'Dimension 5/6 inputs must not affect the evidence-item coverage percentage')
})

// --- determineMandatoryEvidenceResolved -------------------------------

test('determineMandatoryEvidenceResolved: everything clears -> resolved true, no reasons', () => {
  const result = determineMandatoryEvidenceResolved({ hasIssn: true, lifecycleStage: 'early_stage', sampleAdequacy: { sufficient: true, size: 30 } })
  assert.equal(result.resolved, true)
  assert.deepEqual(result.reasons, [])
})

test('determineMandatoryEvidenceResolved: no ISSN blocks, with a specific reason', () => {
  const result = determineMandatoryEvidenceResolved({ hasIssn: false, lifecycleStage: 'early_stage', sampleAdequacy: { sufficient: true, size: 30 } })
  assert.equal(result.resolved, false)
  assert.ok(result.reasons.some(r => r.includes('ISSN')))
})

test('determineMandatoryEvidenceResolved: insufficient article sample blocks, with the real size named in the reason', () => {
  const result = determineMandatoryEvidenceResolved({ hasIssn: true, lifecycleStage: 'early_stage', sampleAdequacy: { sufficient: false, size: 3 } })
  assert.equal(result.resolved, false)
  assert.ok(result.reasons.some(r => r.includes('3') && r.includes('10')))
})

test('determineMandatoryEvidenceResolved: non-early_stage lifecycle blocks too (defense in depth even though rateJournal() short-circuits earlier)', () => {
  const result = determineMandatoryEvidenceResolved({ hasIssn: true, lifecycleStage: 'observation', sampleAdequacy: { sufficient: true, size: 30 } })
  assert.equal(result.resolved, false)
})

// --- rateJournal: end-to-end ------------------------------------------

const RATING_DATE = new Date('2026-08-14T00:00:00Z')

function fakeJournal(overrides = {}) {
  return {
    posi_id: 'POSI-J-TEST', issn_online: '1234-5678', issn_print: null,
    frequency: 'Monthly',
    early_stage_rating: { first_published: '2025-01-15' }, // ~19 months before 2026-08-14
    ...overrides,
  }
}

function fakeJournalEvidence(itemStatuses = ALL_MET_SITE_ITEMS) {
  return { evidence_items: Object.entries(itemStatuses).map(([id, status]) => ({ id, status })) }
}

function fakeWorksEvidence(overrides = {}) {
  return {
    total_results: 30,
    article_sample: RICH_ARTICLES,
    sample_adequacy: { sufficient: true, size: 30, meets_target: true, spans_multiple_periods: true, note: 'ok' },
    infrastructure_item_statuses: ALL_MET_INFRA,
    publishing_stability: { cadence: { expectedWindows: 10, metWindows: 9 }, continuity: { totalWindows: 6, activeWindows: 6 }, deposit_timeliness: 'met' },
    ...overrides,
  }
}

test('rateJournal: outside the Early-Stage window (still Observation) -> not_applicable, no score, no fabricated dimensions', () => {
  const journal = fakeJournal({ early_stage_rating: { first_published: '2026-01-01' } }) // ~7 months old
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(result.lifecycle_stage, 'observation')
  assert.equal(result.rating_status, 'not_applicable')
  assert.equal(result.total, null)
  assert.equal(result.subfactors, null)
  assert.ok(result.not_rateable_reason.includes('observation'))
})

test('rateJournal: Early-Stage, rich real-shaped evidence on both sources -> official rating with a real computed total', () => {
  const journal = fakeJournal()
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(result.lifecycle_stage, 'early_stage')
  assert.equal(result.rating_status, 'official')
  assert.equal(result.version, 'AJR-E-1.1')
  assert.ok(typeof result.total === 'number' && result.total > 0)
  assert.ok(result.subfactors)
  assert.equal(Object.keys(result.subfactors).sort().join(','), ['egf', 'inf', 'pub', 'rdc', 'rif', 'soc', 'trn'].sort().join(','))
  assert.equal(result.not_rateable_reason, null)
})

test('rateJournal: Early-Stage but article sample below minimum -> not_rateable via the mandatory-evidence gate, even with perfect site evidence', () => {
  const journal = fakeJournal()
  const worksEvidence = fakeWorksEvidence({
    article_sample: RICH_ARTICLES.slice(0, 3),
    sample_adequacy: { sufficient: false, size: 3, meets_target: false, spans_multiple_periods: false, note: 'too few' },
  })
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence, ratingDate: RATING_DATE })
  assert.equal(result.rating_status, 'not_rateable')
  assert.equal(result.total, null, 'a score must never be shown once the mandatory-evidence gate fails, regardless of what the numbers would have been')
  assert.ok(result.not_rateable_reason.includes('mandatory evidence'))
  assert.ok(result.not_rateable_reason.includes('3'))
})

test('rateJournal: Early-Stage, mandatory evidence resolved, but real coverage below 60% -> not_rateable via the coverage threshold, not the mandatory gate', () => {
  const journal = fakeJournal()
  // Only a handful of site items resolved (rest default to unknown) -> low coverage.
  const sparseEvidence = { evidence_items: [{ id: 'aims_scope_explicit', status: 'met' }] }
  const result = rateJournal({ journal, journalEvidence: sparseEvidence, worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(result.rating_status, 'not_rateable')
  assert.ok(result.not_rateable_reason.includes('coverage'))
  assert.equal(result.total, null)
})

test('rateJournal: no evidence/journals record at all (null) -- handled gracefully, not a crash, resolves to not_rateable on coverage', () => {
  const journal = fakeJournal()
  const result = rateJournal({ journal, journalEvidence: null, worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(result.rating_status, 'not_rateable')
})

test('rateJournal: no evidence/works record at all (null) -- article sample defaults to insufficient, mandatory gate blocks', () => {
  const journal = fakeJournal()
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence: null, ratingDate: RATING_DATE })
  assert.equal(result.rating_status, 'not_rateable')
  assert.ok(result.not_rateable_reason.includes('mandatory evidence'))
})

test('rateJournal: quartile/cohort fields are always null -- ranking is the orchestrator\'s job, not this function\'s', () => {
  const journal = fakeJournal()
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(result.quartile, null)
  assert.equal(result.quartile_label, null)
  assert.equal(result.cohort_key, null)
  assert.equal(result.ranking_method, null)
})

test('rateJournal: months_since_launch is re-derived via LIFECYCLE-1.1 exact-date arithmetic, not trusted from a stale prior value', () => {
  // Launched 2024-08-31; a naive calendar-month check would misjudge this
  // near a month-end boundary (see lifecycle.mjs's own header example) --
  // confirms rateJournal() goes through classifyLifecycle(), not a
  // pre-existing months_since_launch field on the journal record.
  const journal = fakeJournal({ early_stage_rating: { first_published: '2024-08-31' } })
  const result = rateJournal({ journal, journalEvidence: fakeJournalEvidence(), worksEvidence: fakeWorksEvidence(), ratingDate: RATING_DATE })
  assert.equal(typeof result.months_since_launch, 'number')
  assert.equal(result.lifecycle_stage, 'early_stage')
})
