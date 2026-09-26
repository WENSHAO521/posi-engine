import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankPcsTrack, pcsQEligibility, PCS_Q_MIN_ITEMS, PCS_Q_MIN_COVERAGE, MIN_CATEGORY_SIZE } from '../src/pcs-quartile.mjs'

const j = (id, pcs, extra = {}) => ({
  journal_id: id, pcs, pcs_eligible_items: 50, pcs_coverage: 1,
  psc_category: 'P1.01', psc_confidence: 'high', ...extra,
})

test('eligibility reasons are reported in order', () => {
  assert.deepEqual(pcsQEligibility({ pcs: null, pcs_eligible_items: 50, pcs_coverage: 1 }), { eligible: false, reason: 'no_pcs' })
  assert.deepEqual(pcsQEligibility({ pcs: 1, pcs_eligible_items: PCS_Q_MIN_ITEMS - 1, pcs_coverage: 1 }), { eligible: false, reason: 'too_few_items' })
  assert.deepEqual(pcsQEligibility({ pcs: 1, pcs_eligible_items: 50, pcs_coverage: PCS_Q_MIN_COVERAGE - 0.01 }), { eligible: false, reason: 'incomplete_fetch' })
  assert.deepEqual(pcsQEligibility({ pcs: 0, pcs_eligible_items: 50, pcs_coverage: 1 }), { eligible: true, reason: null })
})

test('category of MIN_CATEGORY_SIZE journals gets RANK-1.0 quartiles with PCS-Q labels', () => {
  const rows = Array.from({ length: MIN_CATEGORY_SIZE }, (_, i) => j(`J${i}`, MIN_CATEGORY_SIZE - i))
  const out = rankPcsTrack(rows, { metric_year: 2026 })
  const top = out.find(r => r.journal_id === 'J0')
  const bottom = out.find(r => r.journal_id === `J${MIN_CATEGORY_SIZE - 1}`)
  assert.equal(top.rank, 1)
  assert.equal(top.quartile_label, 'PCS-Q1')
  assert.equal(top.percentile, 97.5) // 100 * (20 - 1 + 0.5) / 20
  assert.equal(bottom.quartile_label, 'PCS-Q4')
  assert.equal(top.ranking_method, 'pcs_midrank')
  assert.equal(top.overall_rank, 1)
})

test('ties share a mid-rank and a percentile', () => {
  const rows = Array.from({ length: MIN_CATEGORY_SIZE }, (_, i) => j(`J${i}`, i < 3 ? 10 : 1))
  const out = rankPcsTrack(rows, { metric_year: 2026 })
  const tied = out.filter(r => r.pcs === 10)
  assert.equal(new Set(tied.map(r => r.percentile)).size, 1)
  assert.equal(tied[0].rank, 1)
  assert.equal(tied[0].rank_mid, 2)
  assert.equal(tied[0].tied_with.length, 2)
})

test('small categories get no quartile but keep an overall rank', () => {
  const rows = [j('A', 3), j('B', 2)]
  const out = rankPcsTrack(rows, { metric_year: 2026 })
  assert.equal(out[0].quartile, null)
  assert.equal(out[0].exclusion_reason, 'category_below_min_size')
  assert.equal(out[0].overall_rank, 1)
  assert.equal(out[1].overall_rank, 2)
})

test('low PSC confidence is excluded from category ranking only', () => {
  const rows = [...Array.from({ length: MIN_CATEGORY_SIZE }, (_, i) => j(`J${i}`, i)), j('LOW', 999, { psc_confidence: 'low' })]
  const out = rankPcsTrack(rows, { metric_year: 2026 })
  const low = out.find(r => r.journal_id === 'LOW')
  assert.equal(low.quartile, null)
  assert.equal(low.exclusion_reason, 'psc_confidence_not_rank_eligible')
  assert.equal(low.overall_rank, 1)
  assert.equal(out.find(r => r.journal_id === 'J19').category_size, MIN_CATEGORY_SIZE)
})

test('ineligible journals are returned unranked with their reason', () => {
  const out = rankPcsTrack([j('X', null)], { metric_year: 2026 })
  assert.equal(out[0].overall_rank, null)
  assert.equal(out[0].exclusion_reason, 'no_pcs')
})
