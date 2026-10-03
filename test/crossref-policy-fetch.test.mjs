import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCrossrefPolicySample } from '../src/crossref-policy-fetch.mjs'

const now = new Date('2026-11-07T00:00:00Z')

test('fetchCrossrefPolicySample: three-year window, first ISSN with articles, distinct ISSNs only', async () => {
  const calls = []
  const fetchPage = async (issn, opts) => { calls.push([issn, opts.filter]); return issn === '2222-2222' ? { status: 200, items: [{ DOI: 'x' }] } : { status: 200, items: [] } }
  const r = await fetchCrossrefPolicySample({ issn_online: '1111-1111', issn_print: '2222-2222' }, { now, fetchPage })
  assert.deepEqual([r.since, r.until, r.works.length, r.failed], ['2023-11-07', '2026-11-07', 1, false])
  assert.equal(calls[0][1], 'type:journal-article,from-pub-date:2023-11-07,until-pub-date:2026-11-07')
  assert.match(r.sourceUrl, /journals\/2222-2222\/works/)
  calls.length = 0
  await fetchCrossrefPolicySample({ issn_online: '1111-111x', issn_print: '1111-111X' }, { now, fetchPage })
  assert.equal(calls.length, 1)
})

test('fetchCrossrefPolicySample: a failure is reported, and the other ISSN still tried', async () => {
  const fetchPage = async issn => (issn === '1111-1111' ? { status: 503, items: [], error: 'HTTP 503' } : { status: 404, items: [] })
  const r = await fetchCrossrefPolicySample({ issn_online: '1111-1111', issn_print: '2222-2222' }, { now, fetchPage })
  assert.deepEqual([r.works.length, r.failed, r.attempts.length, r.sourceUrl], [0, true, 2, null])
})
