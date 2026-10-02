import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveness, decideWebsiteUrl } from '../src/website-url.mjs'

const ok = { fetch_status: 'ok', http_status: 200 }
const refused = { fetch_status: 'forbidden', http_status: 403 }
const gone = { fetch_status: 'not_found', http_status: 404 }
const noDns = { fetch_status: 'network_error', http_status: null }

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
  const d = decideWebsiteUrl({ current: 'https://www.sciencedirect.com/journal/x', currentCheck: refused, candidate: 'https://www.elsevier.com/x', candidateCheck: ok })
  assert.equal(d.action, 'keep')
})

test('decideWebsiteUrl: a dead address is replaced by an answering OpenAlex homepage', () => {
  const d = decideWebsiteUrl({ current: 'http://www.blackwellpublishing.com/journal.asp?ref=x', currentCheck: noDns, candidate: 'https://onlinelibrary.wiley.com/journal/x', candidateCheck: refused })
  assert.deepEqual([d.action, d.url], ['replace', 'https://onlinelibrary.wiley.com/journal/x'])
})

test('decideWebsiteUrl: dead with no usable replacement is reported, not changed', () => {
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/', currentCheck: gone, candidate: null, candidateCheck: null }).action, 'dead_no_replacement')
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/', currentCheck: gone, candidate: 'https://b.example/', candidateCheck: gone }).action, 'dead_no_replacement')
  assert.equal(decideWebsiteUrl({ current: 'https://a.example/j/', currentCheck: gone, candidate: 'https://A.example/j', candidateCheck: ok }).action, 'dead_no_replacement')
})

test('decideWebsiteUrl: a missing website is filled only from an answering homepage', () => {
  assert.deepEqual(decideWebsiteUrl({ current: null, currentCheck: null, candidate: 'https://b.example/', candidateCheck: ok }).action, 'add')
  assert.equal(decideWebsiteUrl({ current: null, currentCheck: null, candidate: null, candidateCheck: null }).action, 'missing_no_replacement')
})

test('decideWebsiteUrl: a different query or scheme is a different address', () => {
  assert.equal(decideWebsiteUrl({ current: 'https://a.example/journal?id=old', currentCheck: gone, candidate: 'https://a.example/journal?id=new', candidateCheck: ok }).action, 'replace')
  assert.equal(decideWebsiteUrl({ current: 'http://a.example/j', currentCheck: noDns, candidate: 'https://a.example/j', candidateCheck: ok }).action, 'replace')
})
