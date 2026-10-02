import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reachedSource, shouldReplace } from '../scripts/apply-evidence-refresh.mjs'

test('reachedSource: site crawl counts as reached when any page came back ok', () => {
  assert.equal(reachedSource('journals', { fetched_pages: [{ fetch_status: 'not_found' }, { fetch_status: 'ok' }] }), true)
})

test('reachedSource: site crawl where every page was refused is not reached', () => {
  assert.equal(reachedSource('journals', { fetched_pages: [{ fetch_status: 'forbidden' }, { fetch_status: 'forbidden' }] }), false)
  assert.equal(reachedSource('journals', { fetched_pages: [] }), false)
})

test('reachedSource: article sample needs a Crossref 200', () => {
  assert.equal(reachedSource('works', { crossref_status: 200 }), true)
  assert.equal(reachedSource('works', { crossref_status: 403 }), false)
  assert.equal(reachedSource('works', { crossref_status: null }), false)
})

test('reachedSource: output history needs the OpenAlex record read', () => {
  assert.equal(reachedSource('output', { counts_by_year: { 2025: 3 } }), true)
  assert.equal(reachedSource('output', { counts_by_year: {} }), true)
  assert.equal(reachedSource('output', { counts_by_year: null, fetch_error: 'HTTP 403' }), false)
})

test('reachedSource: unknown kind throws', () => {
  assert.throws(() => reachedSource('publishers', {}))
})

test('shouldReplace: a crawl cut short by its host never replaces a stored complete one', () => {
  // Real case (2026-10 rerate): two timeouts on one journal's site dropped
  // its coverage to 48% and its rating to not_rateable.
  const ok = { fetch_status: 'ok' }
  const partial = { fetched_pages: [ok], evidence_snapshot_status: 'partial_source_unavailable' }
  const complete = { fetched_pages: [ok], evidence_snapshot_status: 'complete' }
  assert.equal(shouldReplace('journals', partial, complete), false)
  assert.equal(shouldReplace('journals', partial, { ...partial }), true)
  assert.equal(shouldReplace('journals', complete, partial), true)
  assert.equal(shouldReplace('journals', partial, null), true)
  assert.equal(shouldReplace('journals', { fetched_pages: [{ fetch_status: 'timeout' }] }, partial), false)
})
