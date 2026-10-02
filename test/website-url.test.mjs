import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveness, decideWebsiteUrl, publisherRewrites, parseWikidataSites } from '../src/website-url.mjs'

const ok = { fetch_status: 'ok', http_status: 200 }
const refused = { fetch_status: 'forbidden', http_status: 403 }
const gone = { fetch_status: 'not_found', http_status: 404 }
const noDns = { fetch_status: 'network_error', http_status: null }
const openalex = (url, check) => ({ url, check, source: 'openalex' })

test('liveness: any answer is alive, a refusal included; 404/410, DNS and timeouts are dead', () => {
  assert.equal(liveness(ok), 'alive')
  assert.equal(liveness(refused), 'alive')
  assert.equal(liveness({ fetch_status: 'server_error', http_status: 503 }), 'alive')
  assert.equal(liveness(gone), 'dead')
  assert.equal(liveness({ fetch_status: 'http_error', http_status: 410 }), 'dead')
  assert.equal(liveness(noDns), 'dead')
  assert.equal(liveness({ fetch_status: 'timeout', http_status: null }), 'dead')
  assert.equal(liveness(null), 'unknown')
})

test('decideWebsiteUrl: a site that refuses the crawler is kept, not replaced', () => {
  const d = decideWebsiteUrl({ current: 'https://www.sciencedirect.com/journal/x', currentCheck: refused, candidates: [openalex('https://www.elsevier.com/x', ok)] })
  assert.equal(d.action, 'keep')
})

test('decideWebsiteUrl: a dead address is replaced by an answering OpenAlex homepage', () => {
  const d = decideWebsiteUrl({ current: 'http://www.blackwellpublishing.com/journal.asp?ref=x', currentCheck: noDns, candidates: [openalex('https://onlinelibrary.wiley.com/journal/x', refused)] })
  assert.deepEqual([d.action, d.url, d.source], ['replace', 'https://onlinelibrary.wiley.com/journal/x', 'openalex'])
})

test('decideWebsiteUrl: dead with no usable replacement is reported, not changed', () => {
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/', currentCheck: gone }).action, 'dead_no_replacement')
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/', currentCheck: gone, candidates: [openalex('https://b.example/', gone)] }).action, 'dead_no_replacement')
  const same = decideWebsiteUrl({ current: 'https://a.example/j/', currentCheck: gone, candidates: [openalex('https://A.example/j', ok)] })
  assert.equal(same.action, 'dead_no_replacement')
  assert.match(same.reason, /same address/)
})

test('decideWebsiteUrl: a missing website is filled only from an answering candidate', () => {
  assert.equal(decideWebsiteUrl({ current: null, currentCheck: null, candidates: [openalex('https://b.example/', ok)] }).action, 'add')
  assert.equal(decideWebsiteUrl({ current: null, currentCheck: null }).action, 'missing_no_replacement')
})

test('decideWebsiteUrl: a different query or scheme is a different address', () => {
  assert.equal(decideWebsiteUrl({ current: 'https://a.example/journal?id=old', currentCheck: gone, candidates: [openalex('https://a.example/journal?id=new', ok)] }).action, 'replace')
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/j', currentCheck: noDns, candidates: [openalex('https://a.example/j', ok)] }).action, 'replace')
})

test('decideWebsiteUrl: falls through to Wikidata when OpenAlex has the same dead address', () => {
  const d = decideWebsiteUrl({
    current: 'http://www.springerlink.com/content/1234', currentCheck: noDns,
    candidates: [openalex('http://www.springerlink.com/content/1234', noDns), { url: 'https://www.springer.com/journal/10551', check: refused, source: 'wikidata' }],
  })
  assert.deepEqual([d.action, d.url, d.source], ['replace', 'https://www.springer.com/journal/10551', 'wikidata'])
})

test('decideWebsiteUrl: an address built by rule must answer 200; a refusal is not enough', () => {
  const rule = check => ({ url: 'https://onlinelibrary.wiley.com/journal/14679248', check, source: 'publisher_rewrite', strict: true })
  assert.equal(decideWebsiteUrl({ current: 'http://www.wiley.com/bw/journal.asp?ref=0032-3217', currentCheck: gone, candidates: [rule(refused)] }).action, 'dead_no_replacement')
  assert.equal(decideWebsiteUrl({ current: 'http://www.wiley.com/bw/journal.asp?ref=0032-3217', currentCheck: gone, candidates: [rule(ok)] }).action, 'replace')
})

test('publisherRewrites: Wiley and Blackwell journals get the ISSN address; others none', () => {
  assert.deepEqual(publisherRewrites({ publisher: 'Wiley-Blackwell', issn_online: '1467-9248', issn_print: '0032-3217' }),
    ['https://onlinelibrary.wiley.com/journal/14679248', 'https://onlinelibrary.wiley.com/journal/00323217'])
  assert.deepEqual(publisherRewrites({ publisher: 'Wiley', issn_online: '1234-567x', issn_print: null }), ['https://onlinelibrary.wiley.com/journal/1234567X'])
  assert.deepEqual(publisherRewrites({ publisher: 'SAGE Publishing', issn_online: '1467-9248' }), [])
  assert.deepEqual(publisherRewrites({ publisher: 'Wiley', issn_online: 'not an issn' }), [])
})

test('parseWikidataSites: groups sites by upper-cased ISSN, drops non-http values and repeats', () => {
  const m = parseWikidataSites({ results: { bindings: [
    { issn: { value: '1234-567x' }, site: { value: 'https://a.example/' } },
    { issn: { value: '1234-567X' }, site: { value: 'https://a.example/' } },
    { issn: { value: '1234-567X' }, site: { value: 'http://b.example/' } },
    { issn: { value: '0000-0000' }, site: { value: 'ftp://c.example/' } },
  ] } })
  assert.deepEqual([...m], [['1234-567X', ['https://a.example/', 'http://b.example/']]])
})
