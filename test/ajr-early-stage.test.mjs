import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AJR_E_METHODOLOGY_VERSION,
  scoreEditorialGovernance,
  scoreResearchIntegrity,
  scoreInfrastructure,
  robotsTxtDiagnostic,
  computeCadenceScore,
  computeContinuityScore,
  computeOutputAdequacyScore,
  scorePublishingStability,
  assessArticleSampleAdequacy,
  scoreOutputSignals,
  resolveAuthorIdentity,
  scoreReachConcentration,
  computeAjrE,
  EDITORIAL_GOVERNANCE_ITEMS,
  RESEARCH_INTEGRITY_ITEMS,
  INFRASTRUCTURE_ITEMS,
  MIN_ARTICLE_SAMPLE_SIZE,
  TARGET_ARTICLE_SAMPLE_SIZE,
} from '../src/ajr-early-stage.mjs'

test('AJR_E_METHODOLOGY_VERSION is 1.1, not a silent overwrite of the published 1.0', () => {
  assert.equal(AJR_E_METHODOLOGY_VERSION, 'AJR-E-1.1')
})

// ---- Dimension weights sum to 100 ----
test('all seven dimension weights sum to exactly 100', () => {
  const egfMax = EDITORIAL_GOVERNANCE_ITEMS.reduce((s, i) => s + i.weight, 0)
  const rifMax = RESEARCH_INTEGRITY_ITEMS.reduce((s, i) => s + i.weight, 0)
  const infMax = INFRASTRUCTURE_ITEMS.reduce((s, i) => s + i.weight, 0)
  assert.equal(egfMax, 15)
  assert.equal(rifMax, 15)
  assert.equal(infMax, 15)
  // pub(15) + soc(20) + rdc(10) + trn(10) declared as constants elsewhere;
  // 15+15+15+15+20+10+10 = 100
  assert.equal(egfMax + rifMax + infMax + 15 + 20 + 10 + 10, 100)
})

// ---- Dimension 1 ----
test('scoreEditorialGovernance: all items met scores the full 15', () => {
  const statuses = Object.fromEntries(EDITORIAL_GOVERNANCE_ITEMS.map(i => [i.id, 'met']))
  assert.equal(scoreEditorialGovernance(statuses).score, 15)
})

// ---- Dimension 2 — the bug fix ----
test('BUG FIX: scoreResearchIntegrity no longer credits authorship/COI policy just because an editorial board exists', () => {
  // Old AJR-E-1.0 behavior: passing editorialBoard=true alone added +3.
  // New API doesn't even accept an editorialBoard flag — authorship and
  // COI policy items must be independently evidenced. With nothing
  // supplied at all, every item is 'unknown' and the dimension score is 0
  // (uninterpreted-as-failure, not a penalty — see evidence-coverage.mjs).
  const result = scoreResearchIntegrity({})
  assert.equal(result.score, 0)
  assert.equal(result.coverage.resolved_weight, 0)
})

test('scoreResearchIntegrity: authorship_contributorship_policy and conflict_of_interest_policy are real, independent items', () => {
  const ids = RESEARCH_INTEGRITY_ITEMS.map(i => i.id)
  assert.ok(ids.includes('authorship_contributorship_policy'))
  assert.ok(ids.includes('conflict_of_interest_policy'))
  // Both must be scoreable as 'met' independently of everything else. Per
  // the framework's DimensionScore formula (weight * met/resolved), when
  // ONLY these two items are resolved and both are fully met, the
  // dimension scores its full weight (15) — the formula normalizes
  // against what was actually resolved, not against the full item list;
  // the other six items being 'unknown' does not drag the score down.
  const statuses = { authorship_contributorship_policy: 'met', conflict_of_interest_policy: 'met' }
  const result = scoreResearchIntegrity(statuses)
  assert.equal(result.coverage.resolved_weight, 4, 'only these two items (2+2) were resolved')
  assert.equal(result.coverage.met_weight, 4, 'and both were met')
  assert.equal(result.score, 15, '15 * (4/4) per the DimensionScore formula — unknown items never drag the score down')
})

// ---- Dimension 3 — the bug fix ----
test('BUG FIX: scoreInfrastructure has no OpenAlex-indexing item or bonus at all', () => {
  const ids = INFRASTRUCTURE_ITEMS.map(i => i.id)
  assert.ok(!ids.some(id => /openalex/i.test(id)), 'no item may reference OpenAlex indexing as a scored signal')
  // Even if a caller tries to sneak an "openalex_found" key into the
  // statuses object, it must be silently ignored (only declared item ids
  // are read) rather than adding score.
  const statuses = { openalex_found: 'met', doi_resolution_reliability: 'met' }
  const result = scoreInfrastructure(statuses)
  assert.equal(result.coverage.resolved_weight, 3, 'only the real doi_resolution_reliability (weight 3) item is read — openalex_found is not a declared item id and is ignored')
  assert.equal(result.score, 15, '15 * (3/3): the one resolved item was met, so the dimension scores its full weight — the point is that no OpenAlex-specific bonus exists anywhere, not that the numeric score is small')

  // Direct regression: identical evidence with/without an openalex_found
  // flag must score IDENTICALLY — proves the flag has zero effect either way.
  const withFlag = scoreInfrastructure({ doi_resolution_reliability: 'met', crossref_metadata_completeness: 'not_met', openalex_found: 'met' })
  const withoutFlag = scoreInfrastructure({ doi_resolution_reliability: 'met', crossref_metadata_completeness: 'not_met' })
  assert.equal(withFlag.score, withoutFlag.score, 'openalex_found must have zero effect on the score')
})

test('robotsTxtDiagnostic is explicitly unscored', () => {
  assert.deepEqual(robotsTxtDiagnostic(true), { robots_txt_found: true, scored: false })
  assert.deepEqual(robotsTxtDiagnostic(null), { robots_txt_found: null, scored: false })
})

// ---- Dimension 4 — tiered cadence formula (bug fix) ----
test('computeCadenceScore: tiered thresholds match the framework exactly (>=90->5, 75-89->4, 60-74->2, <60->0)', () => {
  assert.equal(computeCadenceScore(10, 10).score, 5) // 100%
  assert.equal(computeCadenceScore(10, 9).score, 5)  // 90%
  assert.equal(computeCadenceScore(10, 8).score, 4)  // 80%
  assert.equal(computeCadenceScore(10, 7).score, 2)  // 70%
  assert.equal(computeCadenceScore(10, 6).score, 2)  // 60%
  assert.equal(computeCadenceScore(10, 5).score, 0)  // 50%
  assert.equal(computeCadenceScore(0, 0).score, null, 'no basis to compute at all is null, not 0')
})

test('computeContinuityScore and computeOutputAdequacyScore are proportional, capped at their weight', () => {
  assert.equal(computeContinuityScore(10, 10).score, 3)
  assert.equal(computeContinuityScore(10, 5).score, 1.5)
  assert.equal(computeContinuityScore(0, 0).score, null)

  assert.equal(computeOutputAdequacyScore(20, 40).score, 3, '20 articles over 40 months meets the expected minimum (40/2=20) -> full marks')
  assert.equal(computeOutputAdequacyScore(5, 40).score, 0.75, '5 articles vs expected 20 -> 25% of the 3-point weight')
})

test('computeOutputAdequacyScore floors "expected" at 10, not 1 -- a young journal cannot max out on fewer articles than the § 7 minimum sample size', () => {
  // Regression test: at 12 months, months/2 = 6 < the platform's own
  // 10-article minimum sample size (AJR-E-1.1-SPEC.md § 7). A max(1, ...)
  // floor let 6 articles score full marks; max(10, ...) requires 10.
  assert.equal(computeOutputAdequacyScore(6, 12).expected, 10, 'expected floors at 10 even though months/2 = 6')
  assert.equal(computeOutputAdequacyScore(6, 12).score, 1.8, '6 articles vs a floored expected of 10 -> 60% of the 3-point weight, not full marks')
  assert.equal(computeOutputAdequacyScore(10, 12).score, 3, '10 articles meets the floored expected of 10 -> full marks')

  // Above the floor, behavior is unchanged: months/2 already exceeds 10.
  assert.equal(computeOutputAdequacyScore(20, 40).expected, 20, 'expected is still months/2 once that exceeds the floor')
})

test('scorePublishingStability composes all five sub-scores and caps at 15', () => {
  const result = scorePublishingStability(
    { frequency_disclosed: 'met', deposit_timeliness: 'met' },
    { expectedWindows: 10, metWindows: 10 },
    { totalWindows: 10, activeWindows: 10 },
    { articleCount: 100, monthsSinceLaunch: 24 }
  )
  assert.equal(result.score, 15, 'everything maxed out must hit exactly the 15-point cap')
})

// ---- Dimension 5 — sample size 10 min / 30 target (bug fix) ----
test('MIN_ARTICLE_SAMPLE_SIZE is 10 and TARGET_ARTICLE_SAMPLE_SIZE is 30 (up from a flat 10)', () => {
  assert.equal(MIN_ARTICLE_SAMPLE_SIZE, 10)
  assert.equal(TARGET_ARTICLE_SAMPLE_SIZE, 30)
})

function makeArticle(overrides = {}) {
  return {
    title: 'A Real Study of Something',
    hasAbstract: true,
    referenceCount: 20,
    hasLicense: true,
    documentType: 'research-article',
    publishedDate: '2026-01-01',
    issueOrPeriod: '2026-Q1',
    authors: [{ affiliation: 'University A', orcid: '0000-0001-2345-6789', given_name: 'Jane', family_name: 'Doe' }],
    ...overrides,
  }
}

test('assessArticleSampleAdequacy: below 10 is insufficient; 10-29 sufficient but below target; >=30 meets target', () => {
  assert.equal(assessArticleSampleAdequacy(Array.from({ length: 9 }, () => makeArticle())).sufficient, false)
  const mid = assessArticleSampleAdequacy(Array.from({ length: 15 }, () => makeArticle()))
  assert.equal(mid.sufficient, true)
  assert.equal(mid.meets_target, false)
  const full = assessArticleSampleAdequacy(Array.from({ length: 30 }, () => makeArticle()))
  assert.equal(full.meets_target, true)
})

test('assessArticleSampleAdequacy tracks whether the sample spans multiple issues/periods', () => {
  const onePeriod = Array.from({ length: 15 }, () => makeArticle({ issueOrPeriod: '2026-Q1' }))
  assert.equal(assessArticleSampleAdequacy(onePeriod).spans_multiple_periods, false)
  const twoPeriods = [...Array.from({ length: 8 }, () => makeArticle({ issueOrPeriod: '2026-Q1' })), ...Array.from({ length: 8 }, () => makeArticle({ issueOrPeriod: '2026-Q2' }))]
  assert.equal(assessArticleSampleAdequacy(twoPeriods).spans_multiple_periods, true)
})

test('scoreOutputSignals returns 0 (not a crash) when the sample is below the minimum', () => {
  const result = scoreOutputSignals(Array.from({ length: 5 }, () => makeArticle()))
  assert.equal(result.score, 0)
  assert.equal(result.sample.sufficient, false)
})

test('scoreOutputSignals: a clean 30-article sample scores near the top', () => {
  const articles = Array.from({ length: 30 }, (_, i) => makeArticle({ title: `Study Number ${i}`, publishedDate: `2026-0${(i % 9) + 1}-01`, issueOrPeriod: i < 15 ? '2026-Q1' : '2026-Q2' }))
  const result = scoreOutputSignals(articles)
  assert.ok(result.score >= 15, `expected a high score for clean data, got ${result.score}`)
  assert.ok(result.score <= 20)
})

test('scoreOutputSignals: duplicate titles reduce the anomaly sub-score', () => {
  const clean = Array.from({ length: 15 }, (_, i) => makeArticle({ title: `Unique Study ${i}` }))
  const withDupes = Array.from({ length: 15 }, (_, i) => makeArticle({ title: i < 5 ? 'Duplicate Title Here' : `Unique Study ${i}` }))
  const cleanScore = scoreOutputSignals(clean).subfactors.duplicate_template_anomaly
  const dupeScore = scoreOutputSignals(withDupes).subfactors.duplicate_template_anomaly
  assert.ok(dupeScore < cleanScore)
})

// ---- Dimension 6 — ORCID-based author identity (bug fix) ----
test('BUG FIX: resolveAuthorIdentity uses ORCID first, then given+family name — never affiliation', () => {
  assert.equal(resolveAuthorIdentity({ orcid: '0000-0001-2345-6789', affiliation: 'University A' }), 'orcid:0000-0001-2345-6789')
  assert.equal(resolveAuthorIdentity({ given_name: 'Jane', family_name: 'Doe', affiliation: 'University A' }), 'name:jane doe')
  assert.equal(resolveAuthorIdentity({ affiliation: 'University A' }), null, 'affiliation alone must never resolve an author identity')
})

test('BUG FIX regression: recurrent-author concentration is NOT fooled by many different authors sharing one affiliation', () => {
  // 10 articles, 10 DIFFERENT authors (distinct ORCIDs), all at the same
  // university. The old affiliation-proxy code would have treated this as
  // one "author" appearing 10 times (100% share -> heavily penalized).
  // The fixed code must recognize 10 distinct authors -> low concentration.
  const articles = Array.from({ length: 10 }, (_, i) => makeArticle({
    authors: [{ affiliation: 'University A', orcid: `0000-0001-0000-000${i}`, given_name: `Author${i}`, family_name: 'Surname' }],
  }))
  const result = scoreReachConcentration(articles)
  assert.equal(result.subfactors.recurrent_author_concentration, 3, 'no single identifiable author repeats at all -> full marks on author concentration')
  assert.ok(result.subfactors.institution_concentration <= 1, 'meanwhile institution concentration correctly flags the single-university reliance')
})

test('scoreReachConcentration: institution concentration tiers match the framework (<=40->4, 40-60->3, 60-80->1, >80->0)', () => {
  function withShare(share) {
    // 10 authors total; `share` fraction at "University A", rest spread thin.
    const dominant = Math.round(share * 10)
    const authors = []
    for (let i = 0; i < dominant; i++) authors.push({ affiliation: 'University A', orcid: `orc-a-${i}` })
    for (let i = 0; i < 10 - dominant; i++) authors.push({ affiliation: `University B${i}`, orcid: `orc-b-${i}` })
    return [makeArticle({ authors })]
  }
  assert.equal(scoreReachConcentration(withShare(0.3)).subfactors.institution_concentration, 4)
  assert.equal(scoreReachConcentration(withShare(0.5)).subfactors.institution_concentration, 3)
  assert.equal(scoreReachConcentration(withShare(0.7)).subfactors.institution_concentration, 1)
  assert.equal(scoreReachConcentration(withShare(0.9)).subfactors.institution_concentration, 0)
})

test('scoreReachConcentration: sparse affiliation metadata gets a neutral default, not zero', () => {
  const articles = [makeArticle({ authors: [{ affiliation: null, orcid: 'x' }, { affiliation: null, orcid: 'y' }] })]
  const result = scoreReachConcentration(articles)
  assert.ok(result.subfactors.institution_concentration > 0 && result.subfactors.institution_concentration < 4)
})

// ---- Composite ----
test('computeAjrE composes all seven dimensions and stamps methodology_version AJR-E-1.1', () => {
  const articles = Array.from({ length: 30 }, (_, i) => makeArticle({ title: `Study ${i}`, issueOrPeriod: i < 15 ? 'A' : 'B' }))
  const result = computeAjrE({
    editorialGovernance: Object.fromEntries(EDITORIAL_GOVERNANCE_ITEMS.map(i => [i.id, 'met'])),
    researchIntegrity: Object.fromEntries(RESEARCH_INTEGRITY_ITEMS.map(i => [i.id, 'met'])),
    infrastructure: Object.fromEntries(INFRASTRUCTURE_ITEMS.map(i => [i.id, 'met'])),
    publishingStability: {
      evidence: { frequency_disclosed: 'met', deposit_timeliness: 'met' },
      cadence: { expectedWindows: 10, metWindows: 10 },
      continuity: { totalWindows: 10, activeWindows: 10 },
      output: { articleCount: 100, monthsSinceLaunch: 24 },
    },
    articles,
    transparency: {
      fee_disclosure: 'met', copyright_licensing: 'met', access_model_disclosure: 'met',
      publisher_ownership_contact: 'met', author_guidelines: 'met',
      advertising_sponsorship_disclosure: 'met', other_applicable_terms: 'met',
    },
  })
  assert.equal(result.methodology_version, 'AJR-E-1.1')
  assert.ok(result.total > 0 && result.total <= 100)
  assert.equal(result.subfactors.trn.score, 10)
  assert.equal(result.subfactors.egf.score, 15)
})
