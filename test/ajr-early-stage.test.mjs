import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreEditorialGovernance, scoreResearchIntegrity, scoreInfrastructure,
  scorePublishingStability, scoreTransparency, scoreOutputSignals,
  scoreReachConcentration, computeAjrE,
} from '../src/ajr-early-stage.mjs'

test('scoreEditorialGovernance: null site scores 0, full evidence caps at 15', () => {
  assert.equal(scoreEditorialGovernance(null), 0)
  assert.equal(scoreEditorialGovernance({ editorialBoard: true, peerReview: true, aimScope: true }), 15)
  assert.equal(scoreEditorialGovernance({ editorialBoard: true, peerReview: false, aimScope: false }), 6)
})

test('scoreResearchIntegrity: each of the 5 criteria contributes independently up to 15', () => {
  assert.equal(scoreResearchIntegrity({ corrections: true, plagiarism: false, dataAvailability: false, ethics: false, editorialBoard: false }), 3)
  assert.equal(scoreResearchIntegrity({ corrections: true, plagiarism: true, dataAvailability: true, ethics: true, editorialBoard: true }), 15)
})

test('scoreInfrastructure: all 4 signals independent, caps at 15', () => {
  assert.equal(scoreInfrastructure(false, false, false, false), 0)
  assert.equal(scoreInfrastructure(true, true, true, true), 15)
})

test('scorePublishingStability: article-count-vs-age check requires positive months', () => {
  assert.equal(scorePublishingStability(null, 0, null, false), 0)
  // 20 articles over 16 months clears the >= monthsSinceLaunch/2 bar (8)
  assert.equal(scorePublishingStability({ frequencyStated: true }, 20, 16, true), 15)
})

test('scoreTransparency: APC or waiver (either) contributes the same 2 points', () => {
  assert.equal(scoreTransparency({ openAccess: false, license: false, apc: true, waiver: false }), 2)
  assert.equal(scoreTransparency({ openAccess: false, license: false, apc: false, waiver: true }), 2)
  assert.equal(scoreTransparency({ openAccess: false, license: false, apc: true, waiver: true }), 2)
})

test('scoreOutputSignals: empty article list scores 0', () => {
  assert.equal(scoreOutputSignals([]), 0)
})

test('scoreOutputSignals: complete, well-referenced, non-duplicated articles score highly', () => {
  const articles = Array.from({ length: 5 }, (_, i) => ({
    title: `Article number ${i}`,
    hasAbstract: true,
    referenceCount: 20,
    hasLicense: true,
    publishedDate: `2026-0${i + 1}-01`,
    authors: [{ affiliation: `Institution ${i}`, orcid: `0000-0000-0000-000${i}` }],
  }))
  const score = scoreOutputSignals(articles)
  assert.equal(score, 20, 'full completeness + high reference count + no pattern anomalies should hit the max')
})

test('scoreOutputSignals: duplicate titles trigger the pattern-anomaly penalty (isolated from the author-concentration penalty)', () => {
  const base = { hasAbstract: true, referenceCount: 20, hasLicense: true }
  const articles = [
    { ...base, title: 'Same Title', publishedDate: '2026-01-01', authors: [{ affiliation: 'X', orcid: '0000-0000-0000-0001' }] },
    { ...base, title: 'same title', publishedDate: '2026-02-01', authors: [{ affiliation: 'Y', orcid: '0000-0000-0000-0002' }] }, // normalized-equal title, different author
  ]
  const score = scoreOutputSignals(articles)
  assert.equal(score, 18, 'duplicate-title detection alone should subtract 2 from the pattern sub-score')
})

test('scoreReachConcentration: sparse affiliation metadata gets a neutral default, not penalized', () => {
  const articles = [{ authors: [{ affiliation: null }, { affiliation: null }] }]
  assert.equal(scoreReachConcentration(articles), 5)
})

test('scoreReachConcentration: single-institution dominance scores low', () => {
  const articles = Array.from({ length: 10 }, () => ({ authors: [{ affiliation: 'Same University' }] }))
  const score = scoreReachConcentration(articles)
  assert.ok(score <= 2, 'one institution accounting for 100% of authorship should score near the floor')
})

test('scoreReachConcentration: diverse institutions score highly', () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({ authors: [{ affiliation: `University ${i}` }] }))
  assert.equal(scoreReachConcentration(articles), 10)
})

test('computeAjrE sums all 7 subfactors into the total', () => {
  const result = computeAjrE({
    site: { editorialBoard: true, peerReview: true, aimScope: true, corrections: true, plagiarism: true, dataAvailability: true, ethics: true, openAccess: true, license: true, apc: false, waiver: true, frequencyStated: true },
    sitemapOk: true, robotsOk: true, openAlexFound: true, doiResolves: true,
    articleCount: 20, monthsSinceLaunch: 16,
    articles: [],
  })
  const expectedTotal = result.subfactors.egf + result.subfactors.rif + result.subfactors.inf + result.subfactors.pub + result.subfactors.soc + result.subfactors.rdc + result.subfactors.trn
  assert.equal(result.total, expectedTotal)
  assert.equal(result.total, 15 + 15 + 15 + 15 + 0 + 5 + 10, 'matches the sum of each individual scorer given this evidence (soc=0 since articles=[])')
})
