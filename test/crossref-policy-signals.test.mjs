import { test } from 'node:test'
import assert from 'node:assert/strict'
import { articleSignals, journalSignalShares, journalItemShares, applyCrossrefSignals, MIN_ARTICLES } from '../src/crossref-policy-signals.mjs'

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
  const shares = { articles: MIN_ARTICLES, copyright_licensing: 1, corrections_retractions_policy: 0.9, conflict_of_interest_policy: 0.2 }
  const { items: out, upgraded } = applyCrossrefSignals(items, shares)
  assert.deepEqual(upgraded, ['corrections_retractions_policy'])
  assert.deepEqual(out.map(i => i.status), ['met', 'not_met', 'unknown', 'blocked'])
  assert.equal(out[0].source, 'crossref')
})

test('applyCrossrefSignals: records provenance; never resolves the access model', () => {
  const items = [{ id: 'copyright_licensing', weight: 2, status: 'blocked' }, { id: 'access_model_disclosure', weight: 1, status: 'blocked' }]
  const shares = { articles: 100, copyright_licensing: 1, access_model_disclosure: 1 }
  const { items: out } = applyCrossrefSignals(items, shares, { sourceUrl: 'https://api.crossref.org/journals/1234-5678/works', retrievedAt: '2026-11-07T00:00:00Z' })
  assert.deepEqual([out[0].status, out[0].source_url, out[0].crossref_share, out[0].crossref_articles], ['met', 'https://api.crossref.org/journals/1234-5678/works', 1, 100])
  assert.equal(out[1].status, 'blocked')
})

test('applyCrossrefSignals: too few articles changes nothing', () => {
  const items = [{ id: 'corrections_retractions_policy', weight: 3, status: 'blocked' }]
  assert.deepEqual(applyCrossrefSignals(items, { articles: MIN_ARTICLES - 1, corrections_retractions_policy: 1 }).upgraded, [])
})

test('journalItemShares: alternative signals are OR-ed per article', () => {
  const dates = { assertion: [{ name: 'received' }, { name: 'accepted' }] }
  const review = { relation: { 'has-review': [{ id: 'x' }] } }
  const works = [dates, dates, review, review, {}]
  assert.equal(journalSignalShares(works).review_dates, 0.4)
  assert.equal(journalSignalShares(works).open_review, 0.4)
  assert.equal(journalItemShares(works).peer_review_process_disclosed, 0.8)
})
