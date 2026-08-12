import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVIDENCE_CRITERIA, resolveCriterion, resolveAllCriteria } from '../src/evidence-resolver.mjs'

const WEBSITE = 'https://j.example.com'
const editorialBoard = EVIDENCE_CRITERIA.find(c => c.id === 'editorial_board')
const publicationEthics = EVIDENCE_CRITERIA.find(c => c.id === 'publication_ethics')

test('resolveCriterion: content match on any fetched ok page -> met, with the matching page cited as source', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Welcome to our journal.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/editorial-board`, fetch_status: 'ok', http_status: 200, body: 'Our Editorial Board consists of...', retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(editorialBoard, pages, WEBSITE)
  assert.equal(result.status, 'met')
  assert.equal(result.source_url, `${WEBSITE}/editorial-board`)
})

test('resolveCriterion: bilingual match -- Chinese pattern is detected same as English', () => {
  const pages = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: '本刊编委会由以下专家组成', retrieved_at: '2026-08-12T00:00:00Z' }]
  const result = resolveCriterion(editorialBoard, pages, WEBSITE)
  assert.equal(result.status, 'met')
})

test('THE REVIEW-CAUGHT BUG, FIXED: homepage 200 + this criterion\'s own relevant page 403 -> blocked, NEVER not_met', () => {
  // This is exactly the scenario the pre-fix resolver got wrong: it saw
  // "some page fetched OK" (the homepage) and concluded not_met for
  // publication_ethics, even though the one page most likely to actually
  // carry that policy (/publication-ethics) was blocked, not confirmed
  // absent. A blocked page relevant to THIS criterion must win over an
  // unrelated homepage success.
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Welcome. Nothing about ethics mentioned here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'blocked', 'must be blocked, not not_met -- the relevant page was 403, not confirmed absent')
})

test('the same bug, timeout/5xx variant -> unknown, never not_met', () => {
  const pagesTimeout = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'timeout', http_status: null, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  assert.equal(resolveCriterion(publicationEthics, pagesTimeout, WEBSITE).status, 'unknown')

  const pages5xx = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'server_error', http_status: 503, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  assert.equal(resolveCriterion(publicationEthics, pages5xx, WEBSITE).status, 'unknown')
})

test('an IRRELEVANT page failing does not block an unrelated criterion -- 403 on /apc must not affect publication_ethics', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/apc`, fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'not_met', 'homepage (always-relevant) succeeded and was searched -- a failure on an unrelated /apc page is irrelevant to this criterion')
})

test('a clean 404 on this criterion\'s dedicated guessed path is NOT blocking -- confident not_met once the homepage (always-relevant) was also checked', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing about ethics mentioned here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'not_met', 'a 404 on a guessed path just means that path does not exist here -- not a fetch problem')
})

test('the homepage itself 404ing (dead/wrong base URL) is unresolved, not a confident absence', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'unknown')
})

test('no fetch attempts at all (e.g. no website_url on record) -> unknown', () => {
  assert.equal(resolveCriterion(publicationEthics, [], null).status, 'unknown')
})

test('resolveAllCriteria returns exactly one item per EVIDENCE_CRITERIA entry, weights matching AJR-E-1.1-SPEC.md', () => {
  const items = resolveAllCriteria([], null)
  assert.equal(items.length, EVIDENCE_CRITERIA.length)
  const editorialGovernanceTotal = items
    .filter(i => EVIDENCE_CRITERIA.find(c => c.id === i.id)?.dimension === 'editorial_governance')
    .reduce((s, i) => s + i.weight, 0)
  assert.equal(editorialGovernanceTotal, 15, 'Dimension 1 weights must sum to 15, matching AJR-E-1.1-SPEC.md § 3')
  const transparencyTotal = items
    .filter(i => EVIDENCE_CRITERIA.find(c => c.id === i.id)?.dimension === 'transparency')
    .reduce((s, i) => s + i.weight, 0)
  assert.equal(transparencyTotal, 9, 'this run\'s Transparency subset (excludes "other applicable terms", not crawl-detectable) sums to 9 of the spec\'s 10')
})
