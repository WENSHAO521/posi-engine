import { test } from 'node:test'
import assert from 'node:assert/strict'
import { articleSignals, journalSignalShares, applyCrossrefSignals, MIN_ARTICLES } from '../src/crossref-policy-signals.mjs'

const full = {
  license: [{ URL: 'http://creativecommons.org/licenses/by/4.0/' }],
  'update-policy': 'http://dx.doi.org/10.1016/elsevier_cm_policy',
  assertion: [
    { name: 'received', label: 'Received', group: { name: 'publication_history' } },
    { name: 'accepted', label: 'Accepted', group: { name: 'publication_history' } },
    { name: 'conflict_of_interest', label: 'Conflict of interest' },
    { name: 'data_availability', label: 'Data Availability' },
  ],
  relation: { 'has-review': [{ id: '10.1/x', 'id-type': 'doi' }] },
  funder: [{ name: 'NSF' }],
}

test('articleSignals: reads each deposit', () => {
  assert.deepEqual(articleSignals(full), { license: true, crossmark: true, review_dates: true, open_review: true, coi: true, data: true, funder: true })
  assert.deepEqual(Object.values(articleSignals({})).filter(Boolean), [])
  assert.equal(articleSignals({ assertion: [{ name: 'received' }] }).review_dates, false, 'a received date alone is not a review history')
  assert.equal(articleSignals({ assertion: [{ label: 'Declaration of Competing Interest' }] }).coi, true)
})

test('journalSignalShares: share of articles per signal', () => {
  const s = journalSignalShares([full, {}, full, {}])
  assert.equal(s.articles, 4)
  assert.equal(s.crossmark, 0.5)
  assert.equal(journalSignalShares([]).license, 0)
})

test('applyCrossrefSignals: upgrades only unresolved mapped items, never a site verdict', () => {
  const items = [
    { id: 'corrections_retractions_policy', weight: 3, status: 'blocked' },
    { id: 'copyright_licensing', weight: 2, status: 'not_met' },
    { id: 'conflict_of_interest_policy', weight: 2, status: 'unknown' },
    { id: 'editorial_board_public', weight: 3, status: 'blocked' },
  ]
  const shares = { articles: MIN_ARTICLES, license: 1, crossmark: 0.9, review_dates: 0, open_review: 0, coi: 0.2, data: 0, funder: 0 }
  const { items: out, upgraded } = applyCrossrefSignals(items, shares)
  assert.deepEqual(upgraded, ['corrections_retractions_policy'])
  assert.deepEqual(out.map(i => i.status), ['met', 'not_met', 'unknown', 'blocked'])
})

test('applyCrossrefSignals: too few articles changes nothing', () => {
  const items = [{ id: 'corrections_retractions_policy', weight: 3, status: 'blocked' }]
  assert.deepEqual(applyCrossrefSignals(items, { articles: MIN_ARTICLES - 1, crossmark: 1 }).upgraded, [])
})
