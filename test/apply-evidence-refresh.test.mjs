import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reachedSource } from '../scripts/apply-evidence-refresh.mjs'

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
