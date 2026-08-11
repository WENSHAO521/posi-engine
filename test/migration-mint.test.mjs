import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPosiId, nextSequenceNumber, buildRegistryIndex, resolveOrMintIds } from '../src/migration/mint.mjs'

test('formatPosiId pads to 6 digits with the POSI-J- prefix', () => {
  assert.equal(formatPosiId(1), 'POSI-J-000001')
  assert.equal(formatPosiId(123456), 'POSI-J-123456')
  assert.equal(formatPosiId(1234567), 'POSI-J-1234567', 'never truncates beyond 6 digits, just stops padding')
})

test('nextSequenceNumber is 1 for an empty registry', () => {
  assert.equal(nextSequenceNumber([]), 1)
})

test('nextSequenceNumber continues after the highest existing id, never reusing one', () => {
  const rows = [{ posi_id: 'POSI-J-000005' }, { posi_id: 'POSI-J-000002' }, { posi_id: 'POSI-J-000009' }]
  assert.equal(nextSequenceNumber(rows), 10)
})

test('buildRegistryIndex keys on identity_type:identity_value', () => {
  const idx = buildRegistryIndex([{ posi_id: 'POSI-J-000001', identity_type: 'issn_l', identity_value: '1234-5678' }])
  assert.equal(idx.get('issn_l:1234-5678'), 'POSI-J-000001')
})

test('resolveOrMintIds reuses an existing registry id rather than minting a new one', () => {
  const idx = buildRegistryIndex([{ posi_id: 'POSI-J-000001', identity_type: 'issn_l', identity_value: '1234-5678' }])
  const entities = [{ candidate_id: 'CAND-000001', issn_l: '1234-5678', issn_set: ['1234-5678'], openalex_source_ids: ['S1'] }]
  const { assignments, newRegistryRows } = resolveOrMintIds(entities, idx, 2, '2026-08-11')
  assert.equal(assignments[0].posi_id, 'POSI-J-000001')
  assert.equal(assignments[0].minted, false)
  assert.deepEqual(newRegistryRows, [])
})

test('resolveOrMintIds mints a new sequential id for a genuinely new entity', () => {
  const idx = buildRegistryIndex([])
  const entities = [{ candidate_id: 'CAND-000001', issn_set: ['1111-1111'], openalex_source_ids: [] }]
  const { assignments, newRegistryRows } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.equal(assignments[0].posi_id, 'POSI-J-000001')
  assert.equal(assignments[0].minted, true)
  assert.equal(newRegistryRows[0].identity_type, 'issn_pair')
  assert.equal(newRegistryRows[0].first_seen, '2026-08-11')
})

test('resolveOrMintIds never mints for an unresolved entity (no ISSN, no OpenAlex id)', () => {
  const idx = buildRegistryIndex([])
  const entities = [{ candidate_id: 'CAND-000001', issn_set: [], openalex_source_ids: [] }]
  const { assignments, unresolved } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.deepEqual(assignments, [])
  assert.equal(unresolved.length, 1)
})

test('resolveOrMintIds falls back to OpenAlex Source ID tier when no ISSN is present', () => {
  const idx = buildRegistryIndex([])
  const entities = [{ candidate_id: 'CAND-000001', issn_set: [], openalex_source_ids: ['S12345'] }]
  const { assignments } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.equal(assignments[0].identity_type, 'openalex')
  assert.equal(assignments[0].identity_value, 'S12345')
})

test('resolveOrMintIds sequentially mints distinct ids for two different new entities and never double-mints within one batch', () => {
  const idx = buildRegistryIndex([])
  const entities = [
    { candidate_id: 'CAND-000001', issn_set: ['1111-1111'], openalex_source_ids: [] },
    { candidate_id: 'CAND-000002', issn_set: ['2222-2222'], openalex_source_ids: [] },
  ]
  const { assignments, newRegistryRows } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.equal(assignments[0].posi_id, 'POSI-J-000001')
  assert.equal(assignments[1].posi_id, 'POSI-J-000002')
  assert.equal(newRegistryRows.length, 2)
})

test('resolveOrMintIds gives an entity with a known issn_l true tier-1 priority', () => {
  const idx = buildRegistryIndex([])
  const entities = [{ candidate_id: 'CAND-000001', issn_l: '1111-1111', issn_set: ['1111-1111'], openalex_source_ids: [] }]
  const { assignments } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.equal(assignments[0].identity_type, 'issn_l')
  assert.equal(assignments[0].identity_value, '1111-1111')
})

test('resolveOrMintIds without a known issn_l falls back to the issn_pair tier, not left unresolved', () => {
  const idx = buildRegistryIndex([])
  const entities = [{ candidate_id: 'CAND-000001', issn_set: ['1111-1111'], openalex_source_ids: [] }]
  const { assignments } = resolveOrMintIds(entities, idx, 1, '2026-08-11')
  assert.equal(assignments[0].identity_type, 'issn_pair')
})
