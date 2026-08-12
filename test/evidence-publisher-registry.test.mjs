import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPublisherInheritance, INHERITABLE_CRITERION_IDS } from '../src/evidence-publisher-registry.mjs'

const baseItems = [
  { id: 'publication_ethics', weight: 3, status: 'unknown', source_url: null, retrieved_at: null },
  { id: 'editorial_board', weight: 3, status: 'unknown', source_url: null, retrieved_at: null },
  { id: 'ai_use_policy', weight: 1, status: 'not_met', source_url: 'https://j.example.com', retrieved_at: '2026-08-12' },
]

test('applyPublisherInheritance fills an unknown/blocked inheritable item from a verified, applicable registry entry', () => {
  const registry = [{ publisher: 'Example Publisher', policy_type: 'publication_ethics', scope: 'all_journals', evidence_url: 'https://publisher.example.com/ethics', verified_by: 'reviewer', verified_at: '2026-08-01' }]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  const ethics = result.find(i => i.id === 'publication_ethics')
  assert.equal(ethics.status, 'met')
  assert.equal(ethics.source_url, 'https://publisher.example.com/ethics')
  assert.equal(ethics.inherited_from_publisher, 'Example Publisher')
})

test('applyPublisherInheritance never overrides a resolved not_met -- a real crawled answer beats an inherited one', () => {
  const registry = [{ publisher: 'Example Publisher', policy_type: 'ai_use_policy', scope: 'all_journals', evidence_url: 'https://publisher.example.com/ai', verified_by: 'reviewer', verified_at: '2026-08-01' }]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  const ai = result.find(i => i.id === 'ai_use_policy')
  assert.equal(ai.status, 'not_met', 'the journal-level not_met must survive untouched')
})

test('applyPublisherInheritance never fills a non-inheritable criterion, even if the registry claims it', () => {
  const registry = [{ publisher: 'Example Publisher', policy_type: 'editorial_board', scope: 'all_journals', evidence_url: 'https://publisher.example.com/board', verified_by: 'reviewer', verified_at: '2026-08-01' }]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'editorial_board').status, 'unknown', 'editorial_board is not in INHERITABLE_CRITERION_IDS -- must stay unresolved')
  assert.ok(!INHERITABLE_CRITERION_IDS.includes('editorial_board'))
})

test('applyPublisherInheritance is a no-op with an empty registry (this run\'s actual default -- zero verified entries)', () => {
  const result = applyPublisherInheritance(baseItems, 'Panorama Scholarly Group', [])
  assert.deepEqual(result, baseItems)
})

test('applyPublisherInheritance ignores entries for a different publisher', () => {
  const registry = [{ publisher: 'Some Other Publisher', policy_type: 'publication_ethics', scope: 'all_journals', evidence_url: 'https://other.example.com/ethics', verified_by: 'reviewer', verified_at: '2026-08-01' }]
  const result = applyPublisherInheritance(baseItems, 'Example Publisher', registry)
  assert.equal(result.find(i => i.id === 'publication_ethics').status, 'unknown')
})
