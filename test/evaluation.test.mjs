import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getAJRRating, getPQFStatus, getAJRModel, getLifecycleStage, calculateMidRank, calculatePercentile,
  calculateCitationQuartile, calculatePOSIZone, rankWithTies, getCitationRankingStatus, getRankingOutputs,
} from '../src/evaluation.mjs'

test('AJR Rating boundaries', () => {
  const cases = [[100, 'A+'], [90, 'A+'], [89.99, 'A'], [85, 'A'], [84.99, 'A−'], [80, 'A−'], [79.99, 'B+'], [75, 'B+'],
    [74.99, 'B'], [70, 'B'], [69.99, 'B−'], [65, 'B−'], [64.99, 'C+'], [60, 'C+'], [59.99, 'C'], [50, 'C'], [49.99, 'D'], [0, 'D'],
    [85.72, 'A'], [80.87, 'A−']]
  for (const [s, r] of cases) assert.equal(getAJRRating(s), r, `score ${s}`)
  for (const bad of [null, undefined, NaN, Infinity, -1, 100.01, '85']) assert.equal(getAJRRating(bad), null)
})

test('PQF status bands', () => {
  assert.equal(getPQFStatus(70), 'eligible')
  assert.equal(getPQFStatus(69.99), 'review_required')
  assert.equal(getPQFStatus(50), 'review_required')
  assert.equal(getPQFStatus(49.99), 'insufficient_evidence')
  assert.equal(getPQFStatus(40), 'insufficient_evidence')
  assert.equal(getPQFStatus(39.99), 'not_eligible')
  assert.equal(getPQFStatus(null), null)
})

test('lifecycle and AJR model', () => {
  assert.equal(getLifecycleStage(0), 'observation')
  assert.equal(getLifecycleStage(11), 'observation')
  assert.equal(getLifecycleStage(12), 'early_stage')
  assert.equal(getLifecycleStage(59), 'early_stage')
  assert.equal(getLifecycleStage(60), 'mature')
  assert.equal(getLifecycleStage(null), 'unknown')
  assert.equal(getAJRModel('early_stage'), 'AJR-E')
  assert.equal(getAJRModel('mature'), 'AJR-M')
  assert.equal(getAJRModel('observation'), 'Observation')
})

test('Citation Quartile boundaries', () => {
  const cases = [[74.99, 'Q2'], [75, 'Q1'], [49.99, 'Q3'], [50, 'Q2'], [24.99, 'Q4'], [25, 'Q3'], [100, 'Q1'], [0, 'Q4']]
  for (const [p, q] of cases) assert.equal(calculateCitationQuartile(p), q, `percentile ${p}`)
  assert.equal(calculateCitationQuartile(null), null)
})

test('POSI Zone boundaries', () => {
  const cases = [[95, 1], [94.99, 2], [80, 2], [79.99, 3], [50, 3], [49.99, 4]]
  for (const [p, z] of cases) assert.equal(calculatePOSIZone(p), z, `percentile ${p}`)
})

test('mid-rank and percentile', () => {
  assert.equal(calculateMidRank(2, 3), 2.5)
  assert.equal(calculatePercentile(1, 4), 87.5)
  assert.equal(calculatePercentile(1, 1), 50)
  assert.equal(calculatePercentile(0, 1), 100) // clamped
  assert.equal(calculatePercentile(1, 0), null)
})

test('ties [3.0, 2.0, 2.0, 1.0] share rank, percentile, quartile and zone', () => {
  const r = rankWithTies([{ id: 'a', value: 3 }, { id: 'c', value: 2 }, { id: 'b', value: 2 }, { id: 'd', value: 1 }])
  assert.deepEqual([...'abcd'].map(k => r.get(k).rank), [1, 2, 2, 4])
  assert.equal(r.get('b').rank_mid, 2.5)
  assert.equal(r.get('b').percentile, r.get('c').percentile)
  assert.equal(r.get('b').percentile, 50)
  assert.equal(r.get('b').quartile, r.get('c').quartile)
  assert.equal(r.get('b').zone, r.get('c').zone)
  assert.deepEqual(r.get('b').tied_with, ['c'])
})

test('ties are never broken by input order or id', () => {
  const a = rankWithTies([{ id: 'x', value: 1.5 }, { id: 'y', value: 1.5 }])
  const b = rankWithTies([{ id: 'y', value: 1.5 }, { id: 'x', value: 1.5 }])
  assert.deepEqual(a.get('x'), { ...b.get('x') })
})

const good = { pnci: 1.2, eligibleItems: 40, publicationYears: 3, coverage: 0.95, hasCategory: true }

test('item thresholds: <10, 10–19, >=20', () => {
  assert.equal(getCitationRankingStatus({ ...good, eligibleItems: 9, categorySize: 60 }).status, 'insufficient_items')
  assert.equal(getCitationRankingStatus({ ...good, eligibleItems: 10, categorySize: 60 }).status, 'provisional')
  assert.equal(getCitationRankingStatus({ ...good, eligibleItems: 19, categorySize: 60 }).status, 'provisional')
  assert.equal(getCitationRankingStatus({ ...good, eligibleItems: 20, categorySize: 60 }).status, 'official')
  assert.equal(getCitationRankingStatus({ ...good, eligibleItems: 9, lifecycleStage: 'observation', categorySize: 60 }).status, 'observation')
})

test('official needs two publication years', () => {
  assert.equal(getCitationRankingStatus({ ...good, publicationYears: 1, categorySize: 60 }).status, 'provisional')
  assert.equal(getCitationRankingStatus({ ...good, publicationYears: 2, categorySize: 60 }).status, 'official')
})

test('coverage threshold 90%', () => {
  assert.equal(getCitationRankingStatus({ ...good, coverage: 0.899, categorySize: 60 }).status, 'incomplete_coverage')
  assert.equal(getCitationRankingStatus({ ...good, coverage: 0.9, categorySize: 60 }).status, 'official')
  assert.equal(getCitationRankingStatus({ ...good, coverage: null, categorySize: 60 }).status, 'incomplete_coverage')
})

test('category size tiers 19/20/29/30/49/50', () => {
  assert.equal(getCitationRankingStatus({ ...good, categorySize: 19 }).status, 'insufficient_category')
  assert.equal(getCitationRankingStatus({ ...good, categorySize: 20 }).status, 'official')
  assert.deepEqual(getRankingOutputs('official', 19), { rank: false, quartile: false, zone: null })
  assert.deepEqual(getRankingOutputs('official', 20), { rank: true, quartile: true, zone: null })
  assert.deepEqual(getRankingOutputs('official', 29), { rank: true, quartile: true, zone: null })
  assert.deepEqual(getRankingOutputs('official', 30), { rank: true, quartile: true, zone: 'provisional' })
  assert.deepEqual(getRankingOutputs('official', 49), { rank: true, quartile: true, zone: 'provisional' })
  assert.deepEqual(getRankingOutputs('official', 50), { rank: true, quartile: true, zone: 'official' })
  assert.deepEqual(getRankingOutputs('provisional', 80), { rank: true, quartile: true, zone: null })
})

test('missing data never throws', () => {
  assert.equal(getCitationRankingStatus({}).status, 'not_available')
  assert.equal(getCitationRankingStatus({ pnci: null, eligibleItems: 0, lifecycleStage: 'observation' }).status, 'observation')
  assert.equal(getCitationRankingStatus({ pnci: null, eligibleItems: 30, coverage: 1, hasCategory: true, categorySize: 80 }).status, 'not_available')
  assert.equal(getCitationRankingStatus({ ...good, hasCategory: false, categorySize: null }).status, 'not_available')
})
