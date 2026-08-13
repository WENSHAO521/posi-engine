import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchCrossrefWorksPage, fetchCrossrefTotalResults, fetchAllCrossrefWorks,
  checkDoiResolution, checkOaiPmhEndpoint, WORKS_SELECT_FIELDS, MAX_WORKS_FETCHED_PER_JOURNAL,
} from '../src/works-fetch.mjs'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

test('WORKS_SELECT_FIELDS uses references-count (list-route field name), never reference-count (singleton-route-only field)', () => {
  // Real regression: Crossref's /journals/{issn}/works route 400s on
  // "reference-count" with select-not-available -- verified against the
  // live API before writing this module. Only "references-count" (plural)
  // is valid on the list route.
  assert.ok(WORKS_SELECT_FIELDS.includes('references-count'))
  assert.ok(!WORKS_SELECT_FIELDS.includes('reference-count'))
})

test('fetchCrossrefWorksPage: 200 returns items, total-results, and next-cursor', async () => {
  const fetchImpl = async () => jsonResponse({
    message: { 'total-results': 2, items: [{ DOI: '10.1/a' }, { DOI: '10.1/b' }], 'next-cursor': 'abc123' },
  })
  const result = await fetchCrossrefWorksPage('1234-5678', { fetchImpl })
  assert.equal(result.status, 200)
  assert.equal(result.totalResults, 2)
  assert.equal(result.items.length, 2)
  assert.equal(result.nextCursor, 'abc123')
  assert.equal(result.error, null)
})

test('fetchCrossrefWorksPage: 404 (no ISSN match) is a resolved answer, not an error -- empty items, not retried', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return jsonResponse({}, 404) }
  const result = await fetchCrossrefWorksPage('0000-0000', { fetchImpl })
  assert.equal(result.status, 404)
  assert.equal(result.totalResults, 0)
  assert.deepEqual(result.items, [])
  assert.equal(calls, 1, '404 must not be retried -- it is a definitive answer')
})

test('fetchCrossrefWorksPage: 429 is retried with backoff, then succeeds', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls < 3) return jsonResponse({}, 429)
    return jsonResponse({ message: { 'total-results': 1, items: [{ DOI: '10.1/x' }], 'next-cursor': null } })
  }
  const result = await fetchCrossrefWorksPage('1234-5678', { fetchImpl, maxAttempts: 4 })
  assert.equal(calls, 3)
  assert.equal(result.status, 200)
  assert.equal(result.items.length, 1)
})

test('fetchCrossrefWorksPage: exhausts retries on persistent 500, returns the error', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return jsonResponse({}, 500) }
  const result = await fetchCrossrefWorksPage('1234-5678', { fetchImpl, maxAttempts: 3 })
  assert.equal(calls, 3)
  assert.equal(result.status, 500)
  assert.equal(result.items.length, 0)
  assert.ok(result.error)
})

test('fetchCrossrefWorksPage: network-level throw is retried, then reported as status null with an error message', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('fetch failed') }
  const result = await fetchCrossrefWorksPage('1234-5678', { fetchImpl, maxAttempts: 2 })
  assert.equal(calls, 2)
  assert.equal(result.status, null)
  assert.ok(result.error.includes('fetch failed'))
})

test('fetchCrossrefTotalResults: rows=0 style call surfaces just the count', async () => {
  const fetchImpl = async () => jsonResponse({ message: { 'total-results': 42, items: [] } })
  const result = await fetchCrossrefTotalResults('1234-5678', { fetchImpl })
  assert.equal(result.totalResults, 42)
})

test('fetchAllCrossrefWorks: pages through cursor until next-cursor is null', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls === 1) return jsonResponse({ message: { 'total-results': 3, items: [{ DOI: '1' }, { DOI: '2' }], 'next-cursor': 'page2' } })
    return jsonResponse({ message: { 'total-results': 3, items: [{ DOI: '3' }], 'next-cursor': null } })
  }
  const result = await fetchAllCrossrefWorks('1234-5678', { fetchImpl, rows: 2 })
  assert.equal(result.status, 200)
  assert.equal(result.items.length, 3)
  assert.equal(result.pagesFetched, 2)
})

test('fetchAllCrossrefWorks: stops at maxItems even if more pages remain (defensive cap)', async () => {
  const fetchImpl = async () => jsonResponse({ message: { 'total-results': 1000, items: Array.from({ length: 50 }, (_, i) => ({ DOI: String(i) })), 'next-cursor': 'more' } })
  const result = await fetchAllCrossrefWorks('1234-5678', { fetchImpl, rows: 50, maxItems: 120 })
  assert.equal(result.items.length, 120)
})

test('fetchAllCrossrefWorks: a real ISSN 404 returns cleanly, no infinite loop', async () => {
  const fetchImpl = async () => jsonResponse({}, 404)
  const result = await fetchAllCrossrefWorks('0000-0000', { fetchImpl })
  assert.equal(result.status, 404)
  assert.deepEqual(result.items, [])
})

test('MAX_WORKS_FETCHED_PER_JOURNAL comfortably exceeds ajr-early-stage.mjs TARGET_ARTICLE_SAMPLE_SIZE (30)', () => {
  assert.ok(MAX_WORKS_FETCHED_PER_JOURNAL >= 30)
})

test('checkDoiResolution: a 302 redirect from doi.org means resolved, target page never fetched', async () => {
  let requestedUrl = null
  const fetchImpl = async (url) => { requestedUrl = url; return { status: 302 } }
  const result = await checkDoiResolution('10.63802/afs.v1.i1.79', { fetchImpl })
  assert.equal(result.resolved, true)
  assert.equal(result.http_status, 302)
  assert.ok(requestedUrl.startsWith('https://doi.org/'))
})

test('checkDoiResolution: a 404 from doi.org means not resolved', async () => {
  const fetchImpl = async () => ({ status: 404 })
  const result = await checkDoiResolution('10.1/nonexistent', { fetchImpl })
  assert.equal(result.resolved, false)
  assert.equal(result.http_status, 404)
})

test('checkDoiResolution: network failure -> resolved false, http_status null, error captured', async () => {
  const fetchImpl = async () => { throw new Error('network down') }
  const result = await checkDoiResolution('10.1/x', { fetchImpl })
  assert.equal(result.resolved, false)
  assert.equal(result.http_status, null)
  assert.ok(result.error.includes('network down'))
})

test('checkOaiPmhEndpoint: a genuine <Identify> response with no <error> is ok', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<OAI-PMH><Identify><repositoryName>X</repositoryName></Identify></OAI-PMH>' })
  const result = await checkOaiPmhEndpoint('https://example.com/oai', { fetchImpl })
  assert.equal(result.ok, true)
})

test('checkOaiPmhEndpoint: a 200 response with an <error> element (malformed OAI request) is NOT ok', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<OAI-PMH><error code="badVerb">Illegal verb</error></OAI-PMH>' })
  const result = await checkOaiPmhEndpoint('https://example.com/oai', { fetchImpl })
  assert.equal(result.ok, false)
})

test('checkOaiPmhEndpoint: a 200 response that is just an ordinary HTML page is NOT ok -- must not false-positive on any 200', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html><body>Welcome to our journal</body></html>' })
  const result = await checkOaiPmhEndpoint('https://example.com/not-really-oai', { fetchImpl })
  assert.equal(result.ok, false)
})

test('checkOaiPmhEndpoint: a non-ok HTTP response is reported, not silently ok:false with no signal', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' })
  const result = await checkOaiPmhEndpoint('https://example.com/oai', { fetchImpl })
  assert.equal(result.ok, false)
  assert.equal(result.http_status, 404)
})
