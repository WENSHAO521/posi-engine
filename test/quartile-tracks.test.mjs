import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  percentileMidrank,
  quartileLabel,
  rankTrackCohort,
  rankLifecycleTrack,
  rankCitationTrack,
  TRACK_LABELS,
} from '../src/quartile-tracks.mjs'
import { rankCategory } from '../src/ranking.mjs'

test('percentileMidrank matches PJR-SPEC.md § 8\'s known worked example (100, then 19 descending from 90)', () => {
  const entries = [{ id: 'top', value: 100 }, ...Array.from({ length: 19 }, (_, i) => ({ id: `j${i}`, value: 90 - i }))]
  const records = percentileMidrank(entries)
  const top = records.find(r => r.id === 'top')
  assert.equal(top.percentile, 97.5)
  assert.equal(top.quartile, 'Q1')
})

test('percentileMidrank produces the exact same numbers as ranking.mjs\'s rankCategory for the same input (shared core)', () => {
  const pcis = [10, 9, 8, 7, 2.0, 2.0, 2.0, 5, 4, 3, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1, 1]
  const entries = pcis.map((pci, i) => ({ journal_id: `POSI-J-${String(i + 1).padStart(6, '0')}`, pci }))
  const viaRankCategory = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  const viaShared = percentileMidrank(entries.map(e => ({ id: e.journal_id, value: e.pci })))
  const byId = Object.fromEntries(viaShared.map(r => [r.id, r]))
  for (const r of viaRankCategory) {
    assert.equal(byId[r.journal_id].rank, r.rank, r.journal_id)
    assert.equal(byId[r.journal_id].rank_mid, r.rank_mid, r.journal_id)
    assert.equal(byId[r.journal_id].percentile, r.percentile, r.journal_id)
    assert.equal(byId[r.journal_id].quartile, r.quartile, r.journal_id)
  }
})

test('quartileLabel: never a bare Q1 — always the full track name', () => {
  assert.equal(quartileLabel('early_stage', 'Q1'), 'E-Q1')
  assert.equal(quartileLabel('mature', 'Q3'), 'M-Q3')
  assert.equal(quartileLabel('citation', 'Q2'), 'Citation Q2')
  assert.equal(quartileLabel('early_stage', null), null)
})

test('TRACK_LABELS covers all three tracks', () => {
  assert.deepEqual(TRACK_LABELS, { early_stage: 'E-Q', mature: 'M-Q', citation: 'Citation Q' })
})

test('rankTrackCohort: a mature-lifecycle cohort scored by AJR-M produces M-Q labels, not Q labels', () => {
  const cohortEntries = Array.from({ length: 20 }, (_, i) => ({ id: `m-${i}`, score: 100 - i }))
  const records = rankTrackCohort(cohortEntries, 'mature', { cohort_key: 'P3.03', cohort_level: 2, metric_year: 2027 })
  const top = records.find(r => r.journal_id === 'm-0')
  assert.equal(top.quartile, 'Q1')
  assert.equal(top.quartile_label, 'M-Q1')
  assert.equal(top.track, 'mature')
  assert.equal(top.cohort_size, 20)
})

test('rankLifecycleTrack: same journal can be M-Q1 (governance/citation composite) while a separate Citation Q run gives Q2 — the two tracks never share a computation', () => {
  // 20 mature journals, high-confidence P3.03, AJR-M scores descending.
  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: `POSI-J-${String(i + 1).padStart(6, '0')}`,
    score: 100 - i,
    psc_category: 'P3.03',
    psc_confidence: 'high',
  }))
  const results = rankLifecycleTrack(entries, 'mature', 2027)
  const top = results.find(r => r.journal_id === 'POSI-J-000001')
  assert.equal(top.quartile, 'Q1')
  assert.equal(top.quartile_label, 'M-Q1')
  assert.equal(top.ranking_method, 'score_midrank')
})

test('rankLifecycleTrack: journals with medium/low/unclassified confidence get quartile: null but keep their score', () => {
  const entries = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `hi-${i}`, score: 90, psc_category: 'P3.03', psc_confidence: 'high' })),
    { id: 'lonely', score: 88, psc_category: 'P3.03', psc_confidence: 'low' },
  ]
  const results = rankLifecycleTrack(entries, 'early_stage', 2027)
  const lonely = results.find(r => r.journal_id === 'lonely')
  assert.equal(lonely.quartile, null)
  assert.equal(lonely.quartile_label, null)
  assert.equal(lonely.ranking_method, 'unavailable')
  assert.equal(lonely.score, 88, 'the score itself must never be discarded, only the quartile')
})

test('rankLifecycleTrack: below every cohort threshold, every entry gets ranking_method unavailable but keeps its score', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: `x-${i}`, score: 70 + i, psc_category: 'P6.03', psc_confidence: 'high' }))
  const results = rankLifecycleTrack(entries, 'early_stage', 2027)
  assert.equal(results.length, 5)
  assert.ok(results.every(r => r.ranking_method === 'unavailable' && r.quartile === null && typeof r.score === 'number'))
})

test('rankCitationTrack: reuses rankCategory() unchanged (Citation Q keeps the existing flat MIN_CATEGORY_SIZE rule, no L1 fallback) and adds quartile_label + track', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ journal_id: `POSI-J-${String(i + 1).padStart(6, '0')}`, pci: 20 - i }))
  const viaRankCategory = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  const viaCitationTrack = rankCitationTrack(entries, { category_code: 'P3.03', metric_year: 2027 })
  for (let i = 0; i < entries.length; i++) {
    assert.equal(viaCitationTrack[i].quartile, viaRankCategory[i].quartile)
    assert.equal(viaCitationTrack[i].rank, viaRankCategory[i].rank)
    assert.equal(viaCitationTrack[i].track, 'citation')
  }
  const top = viaCitationTrack.find(r => r.journal_id === 'POSI-J-000001')
  assert.equal(top.quartile_label, 'Citation Q1')
})
