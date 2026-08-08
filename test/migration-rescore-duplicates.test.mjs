import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rescorePossibleDuplicate } from '../src/migration/rescore-duplicates.mjs'

function group(overrides) {
  return { title: 'T', publisher: 'P', legacy_ids: ['a', 'b'], candidate_entities: ['CAND-1', 'CAND-2'], ...overrides }
}

test('both candidates verified to the same OpenAlex source -> openalex_confirms_same', () => {
  const enrichment = new Map([
    ['CAND-1', { status: 'verified', sources: [{ id: 'S1', issn_l: '1111-1111' }] }],
    ['CAND-2', { status: 'verified', sources: [{ id: 'S1', issn_l: '1111-1111' }] }],
  ])
  const result = rescorePossibleDuplicate(group({}), enrichment)
  assert.equal(result.rescoring, 'openalex_confirms_same')
})

test('both candidates verified to clearly different sources -> openalex_confirms_distinct', () => {
  const enrichment = new Map([
    ['CAND-1', { status: 'verified', sources: [{ id: 'S1', issn_l: '1111-1111' }] }],
    ['CAND-2', { status: 'verified', sources: [{ id: 'S2', issn_l: '2222-2222' }] }],
  ])
  const result = rescorePossibleDuplicate(group({}), enrichment)
  assert.equal(result.rescoring, 'openalex_confirms_distinct')
})

test('one candidate not_found -> manual_review (cannot confirm either way)', () => {
  const enrichment = new Map([
    ['CAND-1', { status: 'verified', sources: [{ id: 'S1', issn_l: '1111-1111' }] }],
    ['CAND-2', { status: 'not_found', sources: [] }],
  ])
  const result = rescorePossibleDuplicate(group({}), enrichment)
  assert.equal(result.rescoring, 'manual_review')
})

test('different source ids but OpenAlex agrees on ISSN-L -> stays manual_review, not auto-confirmed distinct', () => {
  const enrichment = new Map([
    ['CAND-1', { status: 'verified', sources: [{ id: 'S1', issn_l: '1111-1111' }] }],
    ['CAND-2', { status: 'verified', sources: [{ id: 'S2', issn_l: '1111-1111' }] }],
  ])
  const result = rescorePossibleDuplicate(group({}), enrichment)
  assert.equal(result.rescoring, 'manual_review')
})
