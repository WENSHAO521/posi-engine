import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPublisherInheritance, INHERITABLE_CRITERION_IDS, registryEntryStatus } from '../src/evidence-publisher-registry.mjs'

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

test('INHERITABLE_CRITERION_IDS: the twelve publisher-wide policies of EC-1.1', () => {
  assert.deepEqual([...INHERITABLE_CRITERION_IDS].sort(), [
    'advertising_sponsorship_disclosure',
    'ai_use_policy',
    'authorship_contributorship_policy',
    'complaints_appeals',
    'conflict_of_interest_policy',
    'copyright_licensing',
    'corrections_retractions_policy',
    'data_availability_sharing',
    'human_animal_ethics_consent',
    'plagiarism_similarity_policy',
    'publication_ethics_policy',
    'publisher_ownership_contact',
  ].sort())
})

test('journal-specific items are never inheritable', () => {
  for (const id of ['aims_scope_explicit', 'editorial_board_public', 'editor_identity_affiliation_verifiable',
    'peer_review_process_disclosed', 'reviewer_editorial_guidelines', 'author_guidelines',
    // a journal's access model differs within one publisher; other terms are not_applicable for every journal
    'access_model_disclosure', 'fee_disclosure', 'other_applicable_terms']) {
    assert.ok(!INHERITABLE_CRITERION_IDS.includes(id), id)
  }
})

test('a publisher-wide policy added in EC-1.1 is inherited', () => {
  const items = [{ id: 'complaints_appeals', weight: 1, status: 'blocked', source_url: null, retrieved_at: null }]
  const registry = [wellFormedEntry({ policy_type: 'complaints_appeals' })]
  assert.equal(applyPublisherInheritance(items, 'Example Publisher', registry)[0].status, 'met')
})

test('registryEntryStatus: what the ETL does with an entry', () => {
  assert.equal(registryEntryStatus(wellFormedEntry()), 'active')
  assert.equal(registryEntryStatus(wellFormedEntry({ policy_type: 'complaints_appeals' })), 'active')
  assert.equal(registryEntryStatus(wellFormedEntry({ policy_type: 'fee_disclosure' })), 'invalid')
  assert.equal(registryEntryStatus(wellFormedEntry({ verified_by: '' })), 'draft')
  assert.equal(registryEntryStatus(wellFormedEntry({ evidence_url: 'not a url' })), 'invalid')
  assert.equal(registryEntryStatus(wellFormedEntry({ scope: 'some_journals' })), 'invalid')
  assert.equal(registryEntryStatus(wellFormedEntry({ policy_type: 'access_model_disclosure' })), 'invalid')
  assert.equal(registryEntryStatus(wellFormedEntry({ publisher: '' })), 'invalid')
  assert.equal(registryEntryStatus(wellFormedEntry({ publisher: undefined })), 'invalid')
})

test('an entry without a publisher name is never inherited, even through an alias', () => {
  const registry = [wellFormedEntry({ publisher: '', publisher_aliases: ['Example Publisher'] })]
  assert.equal(applyPublisherInheritance(baseItems, 'Example Publisher', registry).find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})

test('applyPublisherInheritance matches a journal recorded under one of the entry\'s aliases', () => {
  const registry = [wellFormedEntry({ publisher: 'Elsevier', publisher_aliases: ['Elsevier BV', 'Cell Press'] })]
  assert.equal(applyPublisherInheritance(baseItems, 'Cell Press', registry).find(i => i.id === 'publication_ethics_policy').status, 'met')
  assert.equal(applyPublisherInheritance(baseItems, 'Elsevier Inc', registry).find(i => i.id === 'publication_ethics_policy').status, 'unknown')
})
