import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankCategory, MIN_CATEGORY_SIZE } from '../src/ranking.mjs'

function makeEntries(pcis) {
  return pcis.map((pci, i) => ({ journal_id: `POSI-J-${String(i + 1).padStart(6, '0')}`, pci }))
}

test('below MIN_CATEGORY_SIZE, no quartiles are assigned', () => {
  const entries = makeEntries(Array.from({ length: MIN_CATEGORY_SIZE - 1 }, (_, i) => i + 1))
  const records = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  assert.equal(records.length, entries.length)
  for (const r of records) {
    assert.equal(r.ranking_method, 'unavailable')
    assert.equal(r.quartile, null)
    assert.equal(r.percentile, null)
    assert.equal(r.rank, null)
  }
})

test('exactly MIN_CATEGORY_SIZE journals, no ties: top journal is Q1, bottom is Q4', () => {
  const size = MIN_CATEGORY_SIZE
  const entries = makeEntries(Array.from({ length: size }, (_, i) => size - i)) // descending PCI
  const records = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  const byId = Object.fromEntries(records.map(r => [r.journal_id, r]))

  assert.equal(byId['POSI-J-000001'].rank, 1)
  assert.equal(byId['POSI-J-000001'].quartile, 'Q1')
  assert.equal(byId[`POSI-J-${String(size).padStart(6, '0')}`].rank, size)
  assert.equal(byId[`POSI-J-${String(size).padStart(6, '0')}`].quartile, 'Q4')
  assert.equal(byId['POSI-J-000001'].ranking_method, 'pci_midrank')
})

test('tied PCI values share the same mid-rank and percentile', () => {
  // 20 journals, three of them tied at PCI 2.0 (wherever that value lands after sorting)
  const pcis = [10, 9, 8, 7, 2.0, 2.0, 2.0, 5, 4, 3, 2.9, 2.8, 2.7, 2.6, 2.5, 2.4, 2.3, 2.2, 2.1, 1]
  const entries = makeEntries(pcis)
  const records = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  const tiedIds = entries.filter(e => e.pci === 2.0).map(e => e.journal_id)
  const tied = records.filter(r => tiedIds.includes(r.journal_id))
  assert.equal(tied.length, 3, 'all three tied journals should be present')
  const ranks = new Set(tied.map(r => r.rank))
  assert.equal(ranks.size, 1, 'all three tied journals should share one mid-rank')
  const percentiles = new Set(tied.map(r => r.percentile))
  assert.equal(percentiles.size, 1, 'tied journals must share one percentile value')
  for (const r of tied) {
    assert.deepEqual(
      new Set(r.tied_with.concat([r.journal_id])),
      new Set(tied.map(t => t.journal_id)),
      'tied_with must reference the other tied journals, not itself'
    )
  }
})

test('percentile formula matches PJR-SPEC.md § 8 exactly for a known case', () => {
  // category_size = 20, rank_mid = 1 (sole top journal, no tie)
  // percentile = 100 * (20 - 1 + 0.5) / 20 = 97.5
  const entries = makeEntries([100, ...Array.from({ length: 19 }, (_, i) => 90 - i)])
  const records = rankCategory(entries, { category_code: 'P3.03', metric_year: 2027 })
  const top = records.find(r => r.journal_id === 'POSI-J-000001')
  assert.equal(top.percentile, 97.5)
  assert.equal(top.quartile, 'Q1')
})
