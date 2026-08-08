import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEnrichment } from '../src/migration/openalex-enrich.mjs'

function src(overrides) {
  return { id: 'S1', issn_l: '1234-5678', issn: ['1234-5678'], type: 'journal', ...overrides }
}

test('both ISSNs resolve to the same journal source -> verified', () => {
  const lookups = new Map([
    ['1111-1111', { status: 200, source: src({ issn_l: '1111-1111' }) }],
    ['2222-2222', { status: 200, source: src({ issn_l: '1111-1111' }) }],
  ])
  const result = classifyEnrichment(['1111-1111', '2222-2222'], lookups)
  assert.equal(result.status, 'verified')
})

test('one ISSN resolves, the other 404s -> partial_match (not verified, not failed)', () => {
  const lookups = new Map([
    ['1111-1111', { status: 200, source: src() }],
    ['2222-2222', { status: 404, source: null }],
  ])
  const result = classifyEnrichment(['1111-1111', '2222-2222'], lookups)
  assert.equal(result.status, 'partial_match')
})

test('all ISSNs 404 -> not_found', () => {
  const lookups = new Map([
    ['1111-1111', { status: 404, source: null }],
  ])
  const result = classifyEnrichment(['1111-1111'], lookups)
  assert.equal(result.status, 'not_found')
})

test('two ISSNs resolve to two DIFFERENT sources -> multiple_sources, never auto-picked', () => {
  const lookups = new Map([
    ['1111-1111', { status: 200, source: src({ id: 'S1' }) }],
    ['2222-2222', { status: 200, source: src({ id: 'S2' }) }],
  ])
  const result = classifyEnrichment(['1111-1111', '2222-2222'], lookups)
  assert.equal(result.status, 'multiple_sources')
  assert.equal(result.sources.length, 2)
})

test('resolved source is not a journal (e.g. a repository) -> source_type_conflict', () => {
  const lookups = new Map([
    ['1111-1111', { status: 200, source: src({ type: 'repository' }) }],
  ])
  const result = classifyEnrichment(['1111-1111'], lookups)
  assert.equal(result.status, 'source_type_conflict')
})

test('a non-404 error (network/5xx) -> review_required, not silently treated as not_found', () => {
  const lookups = new Map([
    ['1111-1111', { status: null, source: null, error: 'timeout' }],
  ])
  const result = classifyEnrichment(['1111-1111'], lookups)
  assert.equal(result.status, 'review_required')
})
