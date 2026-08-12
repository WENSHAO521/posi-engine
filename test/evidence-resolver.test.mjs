import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVIDENCE_CRITERIA, resolveCriterion, resolveAllCriteria } from '../src/evidence-resolver.mjs'

const criterion = EVIDENCE_CRITERIA.find(c => c.id === 'editorial_board')

test('resolveCriterion: content match on any fetched ok page -> met, with the matching page cited as source', () => {
  const pages = [
    { url: 'https://j.example.com', fetch_status: 'ok', http_status: 200, body: 'Welcome to our journal.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: 'https://j.example.com/about', fetch_status: 'ok', http_status: 200, body: 'Our Editorial Board consists of...', retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(criterion, pages)
  assert.equal(result.status, 'met')
  assert.equal(result.source_url, 'https://j.example.com/about')
})

test('resolveCriterion: bilingual match -- Chinese pattern is detected same as English', () => {
  const pages = [{ url: 'https://j.example.com', fetch_status: 'ok', http_status: 200, body: '本刊编委会由以下专家组成', retrieved_at: '2026-08-12T00:00:00Z' }]
  const result = resolveCriterion(criterion, pages)
  assert.equal(result.status, 'met')
})

test('resolveCriterion: pages fetched successfully but pattern never found anywhere -> not_met (a resolved, real answer)', () => {
  const pages = [
    { url: 'https://j.example.com', fetch_status: 'ok', http_status: 200, body: 'This page has nothing relevant on it.', retrieved_at: '2026-08-12T00:00:00Z' },
  ]
  const result = resolveCriterion(criterion, pages)
  assert.equal(result.status, 'not_met')
  assert.equal(result.source_url, 'https://j.example.com')
})

test('resolveCriterion: every fetch attempt 403/429 -> blocked, not not_met (never conflate a block with a real absence)', () => {
  const pages = [
    { url: 'https://j.example.com', fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:00Z' },
    { url: 'https://j.example.com/about', fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(criterion, pages)
  assert.equal(result.status, 'blocked')
  assert.equal(result.source_url, null)
})

test('resolveCriterion: 404/timeout/network_error -> unknown, not not_met', () => {
  const pages404 = [{ url: 'https://j.example.com', fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, pages404).status, 'unknown')

  const pagesTimeout = [{ url: 'https://j.example.com', fetch_status: 'timeout', http_status: null, body: null, retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, pagesTimeout).status, 'unknown')
})

test('resolveCriterion: no fetch attempts at all (e.g. no website_url on record) -> unknown', () => {
  assert.equal(resolveCriterion(criterion, []).status, 'unknown')
})

test('resolveCriterion: a mix of one 403 and one successful-but-nonmatching page -> not_met wins (a real resolved answer beats an unresolved one)', () => {
  const pages = [
    { url: 'https://j.example.com/blocked-subpage', fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:00Z' },
    { url: 'https://j.example.com', fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(criterion, pages)
  assert.equal(result.status, 'not_met')
})

test('resolveAllCriteria returns exactly one item per EVIDENCE_CRITERIA entry, weights matching AJR-E-1.1-SPEC.md', () => {
  const items = resolveAllCriteria([])
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
