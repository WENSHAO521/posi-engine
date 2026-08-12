import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pscLevel,
  toLevel2,
  toLevel1,
  filterRankEligibleByConfidence,
  buildPeerCohorts,
  MIN_L2_L3_COHORT_SIZE,
  MIN_L1_COHORT_SIZE,
} from '../src/cohort.mjs'

function makeEntries(n, { category, confidence = 'high', prefix = 'j' }) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, psc_category: category, psc_confidence: confidence }))
}

test('pscLevel/toLevel2/toLevel1 parse the P{n}(.NN){0,2} code shape', () => {
  assert.equal(pscLevel('P3'), 1)
  assert.equal(pscLevel('P3.03'), 2)
  assert.equal(pscLevel('P3.03.04'), 3)
  assert.equal(toLevel2('P3.03.04'), 'P3.03')
  assert.equal(toLevel2('P3.03'), 'P3.03')
  assert.equal(toLevel1('P3.03.04'), 'P3')
  assert.equal(toLevel1('P3.03'), 'P3')
})

test('filterRankEligibleByConfidence: only high/verified pass, medium/low/unclassified/null are excluded', () => {
  const entries = [
    { id: 'a', psc_category: 'P3.03', psc_confidence: 'high' },
    { id: 'b', psc_category: 'P3.03', psc_confidence: 'verified' },
    { id: 'c', psc_category: 'P3.03', psc_confidence: 'medium' },
    { id: 'd', psc_category: 'P3.03', psc_confidence: 'low' },
    { id: 'e', psc_category: 'P3.03', psc_confidence: 'unclassified' },
    { id: 'f', psc_category: null, psc_confidence: 'high' }, // category itself missing
  ]
  const eligible = filterRankEligibleByConfidence(entries)
  assert.deepEqual(eligible.map(e => e.id), ['a', 'b'])
})

test('buildPeerCohorts: this is the real bug-fix regression — a psc_category-only check would wrongly include medium/low here', () => {
  // 25 "high" confidence + 25 "low" confidence, same category. A cohort
  // builder that only checks psc_category truthiness would form one
  // 50-member cohort. The correct behavior is a 25-member L2 cohort (still
  // >= MIN_L2_L3_COHORT_SIZE) built ONLY from the high-confidence entries.
  const highEntries = makeEntries(25, { category: 'P3.03', confidence: 'high', prefix: 'high' })
  const lowEntries = makeEntries(25, { category: 'P3.03', confidence: 'low', prefix: 'low' })
  const eligible = filterRankEligibleByConfidence([...highEntries, ...lowEntries])
  const cohorts = buildPeerCohorts(eligible)
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0].member_ids.length, 25)
  assert.ok(cohorts[0].member_ids.every(id => id.startsWith('high')), 'no low-confidence entry may appear in the cohort')
})

test('buildPeerCohorts: an L2 category with >= 20 members forms a cohort directly (no L3 data in this taxonomy yet)', () => {
  const entries = makeEntries(MIN_L2_L3_COHORT_SIZE, { category: 'P3.03' })
  const cohorts = buildPeerCohorts(entries)
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0].cohort_level, 2)
  assert.equal(cohorts[0].cohort_key, 'P3.03')
  assert.equal(cohorts[0].member_ids.length, MIN_L2_L3_COHORT_SIZE)
})

test('buildPeerCohorts: an L3 category with >= 20 members forms a Level-3 cohort, taking priority over its L2 ancestor', () => {
  const l3Entries = makeEntries(MIN_L2_L3_COHORT_SIZE, { category: 'P3.03.04', prefix: 'l3' })
  const cohorts = buildPeerCohorts(l3Entries)
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0].cohort_level, 3)
  assert.equal(cohorts[0].cohort_key, 'P3.03.04')
})

test('buildPeerCohorts: L2 below 20 falls back to L1 if the L1 aggregate clears 30', () => {
  // Two distinct L2 categories under the same L1 domain, 15 each (below the
  // L2 bar of 20) but 30 combined at L1 (clears the L1 bar).
  const a = makeEntries(15, { category: 'P3.01', prefix: 'a' })
  const b = makeEntries(15, { category: 'P3.02', prefix: 'b' })
  const cohorts = buildPeerCohorts([...a, ...b])
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0].cohort_level, 1)
  assert.equal(cohorts[0].cohort_key, 'P3')
  assert.equal(cohorts[0].member_ids.length, 30)
})

test('buildPeerCohorts: below every fallback threshold, no cohort is produced at all (score stays, quartile unavailable is the caller\'s job)', () => {
  // 19 members: below the L2 bar (20) directly, AND — since this is the
  // only L2 group under its L1 domain — below the L1 bar (30) too.
  const entries = makeEntries(MIN_L2_L3_COHORT_SIZE - 1, { category: 'P6.01' })
  const cohorts = buildPeerCohorts(entries)
  assert.equal(cohorts.length, 0)
})

test('buildPeerCohorts: an L2 cohort that clears 20 does NOT fall back to L1, even though it also would satisfy L1', () => {
  const entries = makeEntries(22, { category: 'P3.03' })
  const cohorts = buildPeerCohorts(entries)
  assert.equal(cohorts.length, 1)
  assert.equal(cohorts[0].cohort_level, 2, 'must use the finest level that clears its own threshold, not fall further than necessary')
})
