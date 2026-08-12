import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreTransparency, TRANSPARENCY_ITEMS, TRANSPARENCY_DIMENSION_WEIGHT } from '../src/shared-dimensions.mjs'

test('TRANSPARENCY_ITEMS sums to exactly 10 points, matching the framework', () => {
  const total = TRANSPARENCY_ITEMS.reduce((s, i) => s + i.weight, 0)
  assert.equal(total, TRANSPARENCY_DIMENSION_WEIGHT)
  assert.equal(total, 10)
})

test('scoreTransparency: everything met scores the full 10', () => {
  const statuses = Object.fromEntries(TRANSPARENCY_ITEMS.map(i => [i.id, 'met']))
  const result = scoreTransparency(statuses)
  assert.equal(result.score, 10)
  assert.equal(result.coverage.coverage_percent, 100)
})

test('scoreTransparency: an item genuinely Not Applicable (e.g. no advertising at all) enters the applicable-weight normalization rather than penalizing', () => {
  const statuses = Object.fromEntries(TRANSPARENCY_ITEMS.map(i => [i.id, 'met']))
  statuses.advertising_sponsorship_disclosure = 'not_applicable'
  const result = scoreTransparency(statuses)
  assert.equal(result.score, 10, 'a genuinely N/A item must not lower the score below full marks on everything that DOES apply')
  assert.equal(result.coverage.applicable_weight, 9, '10 - 1 (the N/A item\'s weight) = 9')
})

test('scoreTransparency: does NOT require open access — an access-model item marked met for a subscription model scores fully', () => {
  const statuses = Object.fromEntries(TRANSPARENCY_ITEMS.map(i => [i.id, 'met']))
  // access_model_disclosure being "met" here represents "the subscription
  // model IS clearly disclosed" — the item is about disclosure, not about
  // which model was chosen. No separate "is_open_access" bonus exists
  // anywhere in this module — verified by the fact that scoring is 100%
  // determined by TRANSPARENCY_ITEMS status, none of which encode an OA
  // preference.
  const result = scoreTransparency(statuses)
  assert.equal(result.score, 10)
  assert.ok(!TRANSPARENCY_ITEMS.some(i => /open.?access/i.test(i.id) || /open.?access/i.test(i.label)), 'no item may be an open-access preference in disguise')
})

test('scoreTransparency: an item with no evidence gathered yet defaults to unknown, not a failing status', () => {
  const result = scoreTransparency({}) // nothing supplied at all
  assert.equal(result.coverage.resolved_weight, 0)
  assert.equal(result.score, 0, 'uninterpreted-as-failure zero, per evidence-coverage.mjs\'s documented semantics — not "this journal failed transparency"')
})

test('scoreTransparency: a mix of met/not_met normalizes against resolved weight only', () => {
  const statuses = Object.fromEntries(TRANSPARENCY_ITEMS.map(i => [i.id, 'met']))
  statuses.author_guidelines = 'not_met' // weight 1
  statuses.other_applicable_terms = 'unknown' // weight 1, excluded from resolved
  const result = scoreTransparency(statuses)
  // resolved = 10 - 1(unknown) = 9; met = 10 - 1(not_met) - 1(unknown) = 8
  // score = 10 * (8/9)
  assert.equal(result.score, Math.round((10 * (8 / 9)) * 100) / 100)
})
