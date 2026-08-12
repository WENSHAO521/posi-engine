import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evidenceCoverage,
  dimensionScore,
  ratingEligibility,
  describeFetchFailureReason,
  classifyFetchOutcomeStatus,
  EC_OFFICIAL_THRESHOLD,
  EC_PROVISIONAL_THRESHOLD,
} from '../src/evidence-coverage.mjs'

test('evidenceCoverage: all Met is 100% coverage', () => {
  const items = [{ id: 'a', weight: 3, status: 'met' }, { id: 'b', weight: 2, status: 'met' }]
  const result = evidenceCoverage(items)
  assert.equal(result.coverage_percent, 100)
  assert.equal(result.applicable_weight, 5)
  assert.equal(result.resolved_weight, 5)
})

test('evidenceCoverage: Unknown/Blocked count against applicable weight but are excluded from resolved weight (never a failing score)', () => {
  const items = [
    { id: 'a', weight: 3, status: 'met' },
    { id: 'b', weight: 3, status: 'not_met' },
    { id: 'c', weight: 4, status: 'unknown' }, // e.g. HTTP 403
  ]
  const result = evidenceCoverage(items)
  // resolved = a+b = 6, applicable = a+b+c = 10 -> 60%
  assert.equal(result.coverage_percent, 60)
  assert.equal(result.resolved_weight, 6)
  assert.equal(result.met_weight, 3)
})

test('evidenceCoverage: Not Applicable items are removed from the applicable denominator entirely', () => {
  const items = [
    { id: 'a', weight: 2, status: 'met' },
    { id: 'b', weight: 5, status: 'not_applicable' }, // e.g. "advertising disclosure" for a journal with no ads
  ]
  const result = evidenceCoverage(items)
  assert.equal(result.applicable_weight, 2, 'the 5-weight N/A item must not inflate the denominator')
  assert.equal(result.coverage_percent, 100)
  assert.equal(result.not_applicable_weight, 5)
})

test('evidenceCoverage: Conflicted and Stale are applicable but not resolved (same as Unknown/Blocked)', () => {
  const items = [
    { id: 'a', weight: 5, status: 'met' },
    { id: 'b', weight: 5, status: 'conflicted' },
    { id: 'c', weight: 5, status: 'stale' },
  ]
  const result = evidenceCoverage(items)
  assert.equal(result.applicable_weight, 15)
  assert.equal(result.resolved_weight, 5)
  assert.equal(result.coverage_percent, round(5 / 15 * 100))
})

test('evidenceCoverage rejects an invalid status rather than silently ignoring it', () => {
  assert.throws(() => evidenceCoverage([{ id: 'a', weight: 1, status: 'found' }]), /invalid status/)
})

test('dimensionScore: DimensionScore = weight * (met / resolved), matches the framework formula exactly', () => {
  const items = [
    { id: 'a', weight: 6, status: 'met' },
    { id: 'b', weight: 4, status: 'not_met' },
    { id: 'c', weight: 5, status: 'unknown' },
  ]
  // resolved = 6+4=10 (c excluded), met=6 -> score = 15 * (6/10) = 9
  const result = dimensionScore(items, 15)
  assert.equal(result.score, 9)
})

test('dimensionScore: an item POSI could not check (Unknown/Blocked) never silently scores as failed', () => {
  // Single item, entirely unresolved -> resolved_weight is 0 -> score 0,
  // NOT the same semantic as "failed the check" (caller must read
  // coverage.resolved_weight === 0 to distinguish "no data" from "scored
  // zero on the merits").
  const items = [{ id: 'a', weight: 10, status: 'blocked' }]
  const result = dimensionScore(items, 10)
  assert.equal(result.score, 0)
  assert.equal(result.coverage.resolved_weight, 0)
  assert.equal(result.coverage.coverage_percent, 0)
})

test('dimensionScore: Not Applicable items never act as a penalty', () => {
  const allNA = [{ id: 'a', weight: 10, status: 'not_applicable' }]
  const result = dimensionScore(allNA, 10)
  assert.equal(result.coverage.applicable_weight, 0)
  assert.equal(result.score, 0, 'no applicable evidence at all — not a penalty score, just nothing to compute (same 0-but-uninterpreted-as-failure caveat as the fully-unresolved case)')

  const mixedButFullyMet = [
    { id: 'a', weight: 5, status: 'met' },
    { id: 'b', weight: 5, status: 'not_applicable' },
  ]
  const result2 = dimensionScore(mixedButFullyMet, 10)
  assert.equal(result2.score, 10, 'fully met on everything that DOES apply must score the full dimension weight, unpenalized by the N/A item')
})

test('ratingEligibility thresholds: >=80 official, 60-79.99 provisional, <60 not_rateable', () => {
  assert.equal(ratingEligibility(80, true), 'official')
  assert.equal(ratingEligibility(94, true), 'official')
  assert.equal(ratingEligibility(79.99, true), 'provisional')
  assert.equal(ratingEligibility(60, true), 'provisional')
  assert.equal(ratingEligibility(59.99, true), 'not_rateable')
  assert.equal(ratingEligibility(0, true), 'not_rateable')
  assert.equal(EC_OFFICIAL_THRESHOLD, 80)
  assert.equal(EC_PROVISIONAL_THRESHOLD, 60)
})

test('ratingEligibility: mandatory evidence unresolved blocks official rating even at EC=95%', () => {
  assert.equal(ratingEligibility(95, false), 'not_rateable')
})

test('describeFetchFailureReason distinguishes 403/404/429/timeout/network_error instead of collapsing to "not found"', () => {
  assert.equal(describeFetchFailureReason(403), 'http_403_forbidden')
  assert.equal(describeFetchFailureReason(404), 'http_404_not_found')
  assert.equal(describeFetchFailureReason(429), 'http_429_rate_limited')
  assert.equal(describeFetchFailureReason('timeout'), 'timeout')
  assert.equal(describeFetchFailureReason('network_error'), 'network_error')
  assert.equal(describeFetchFailureReason(500), 'http_500_server_error')
  assert.notEqual(describeFetchFailureReason(403), describeFetchFailureReason(404))
})

test('classifyFetchOutcomeStatus: 403/429 (active blocking) map to blocked; everything else maps to unknown, never a failing "not_met"', () => {
  assert.equal(classifyFetchOutcomeStatus(403), 'blocked')
  assert.equal(classifyFetchOutcomeStatus(429), 'blocked')
  assert.equal(classifyFetchOutcomeStatus(404), 'unknown')
  assert.equal(classifyFetchOutcomeStatus('timeout'), 'unknown')
  assert.equal(classifyFetchOutcomeStatus('network_error'), 'unknown')
  assert.equal(classifyFetchOutcomeStatus(500), 'unknown')
})

function round(n) { return Math.round(n * 100) / 100 }
