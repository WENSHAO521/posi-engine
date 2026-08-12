import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPublisherInheritance, INHERITABLE_CRITERION_IDS } from '../src/evidence-publisher-registry.mjs'

const baseItems = [
  { id: 'publication_ethics_policy', weight: 3, status: 'unknown', source_url: null, retrieved_at: null },
  { id: 'editorial_board_public', weight: 3, status: 'unknown', source_url: null, retrieved_at: null },
  { id: 'ai_use_policy', weight: 1, status: 'not_met', source_url: 'https://j.example.com', retrieved_at: '2026-08-12' },
]

const wellFormedEntry = (overrides = {}) => ({
  publisher: 'Example Publisher',
  policy_type: 'publication_ethics_policy',
  scope: 'all_journals',
  evidence_url: 'https://publisher.example.com/ethics',
  verified_by: 'reviewer',
  verified_at: '2026-08-01',
  ...overrides,
})

test('applyPublisherInheritance fills an unknown/blocked inheritable item from a verified, applicable, well-formed registry entry', () => {
  const registry = [wellFormedEntry()]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  const ethics = result.find(i => i.id === 'publication_ethics_policy')
  assert.equal(ethics.status, 'met')
  assert.equal(ethics.source_url, 'https://publisher.example.com/ethics')
  assert.equal(ethics.inherited_from_publisher, 'Example Publisher')
})

test('applyPublisherInheritance never overrides a resolved not_met -- a real crawled answer beats an inherited one', () => {
  const registry = [wellFormedEntry({ policy_type: 'ai_use_policy', evidence_url: 'https://publisher.example.com/ai' })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  const ai = result.find(i => i.id === 'ai_use_policy')
  assert.equal(ai.status, 'not_met', 'the journal-level not_met must survive untouched')
})

test('applyPublisherInheritance never fills a non-inheritable criterion, even if the registry claims it', () => {
  const registry = [wellFormedEntry({ policy_type: 'editorial_board_public', evidence_url: 'https://publisher.example.com/board' })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'editorial_board_public').status, 'unknown', 'editorial_board_public is not in INHERITABLE_CRITERION_IDS -- must stay unresolved')
  assert.ok(!INHERITABLE_CRITERION_IDS.includes('editorial_board_public'))
})

test('applyPublisherInheritance is a no-op with an empty registry (this run\'s actual default -- zero verified entries)', () => {
  const result = applyPublisherInheritance(baseItems, 'Panorama Scholarly Group', [])
  assert.deepEqual(result, baseItems)
})

test('applyPublisherInheritance ignores entries for a different publisher', () => {
  const registry = [wellFormedEntry({ publisher: 'Some Other Publisher', evidence_url: 'https://other.example.com/ethics' })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('REVIEW-CAUGHT GAP, FIXED: an entry missing verified_by is rejected, not silently applied', () => {
  const registry = [wellFormedEntry({ verified_by: undefined })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('REVIEW-CAUGHT GAP, FIXED: an entry with an empty-string verified_by is rejected', () => {
  const registry = [wellFormedEntry({ verified_by: '   ' })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('REVIEW-CAUGHT GAP, FIXED: an entry with an unparseable verified_at is rejected', () => {
  const registry = [wellFormedEntry({ verified_at: 'not-a-date' })]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('REVIEW-CAUGHT GAP, FIXED: an entry with a malformed or non-http(s) evidence_url is rejected', () => {
  const malformed = applyPublisherInheritance(baseItems, 'Example Publisher', [wellFormedEntry({ evidence_url: 'not a url' })])
  assert.equal(malformed.find(i => i.id === 'publication_ethics_policy').status, 'unknown')

  const nonHttp = applyPublisherInheritance(baseItems, 'Example Publisher', [wellFormedEntry({ evidence_url: 'ftp://publisher.example.com/ethics' })])
  assert.equal(nonHttp.find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('INHERITABLE_CRITERION_IDS matches evidence-resolver.mjs\'s canonical AJR-E ids', () => {
  assert.deepEqual([...INHERITABLE_CRITERION_IDS].sort(), [
    'ai_use_policy',
    'authorship_contributorship_policy',
    'conflict_of_interest_policy',
    'corrections_retractions_policy',
    'data_availability_sharing',
    'publication_ethics_policy',
  ].sort())
})
