import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExistingIssnSet, validateConcurrency, partitionOpenAlexLookups, buildExcludedIdentitySet } from '../src/migration/bulk-ingest-helpers.mjs'

test('buildExistingIssnSet includes both issn_print and issn_online, not just one via ||', () => {
  const benchmark = [
    { issn_online: '1111-1111', issn_print: '2222-2222' },
    { issn_online: '3333-3333', issn_print: null },
  ]
  const set = buildExistingIssnSet(benchmark)
  assert.ok(set.has('1111-1111'), 'issn_online is present')
  assert.ok(set.has('2222-2222'), 'issn_print is present even though the same record also has an issn_online')
  assert.ok(set.has('3333-3333'))
  assert.equal(set.size, 3)
})

test('buildExistingIssnSet drops null/empty ISSNs', () => {
  const set = buildExistingIssnSet([{ issn_online: null, issn_print: '' }, { issn_online: '4444-4444' }])
  assert.deepEqual([...set], ['4444-4444'])
})

test('validateConcurrency accepts a positive integer', () => {
  assert.equal(validateConcurrency('6'), 6)
  assert.equal(validateConcurrency('1'), 1)
})

test('validateConcurrency rejects zero (would make the batch loop never advance)', () => {
  assert.throws(() => validateConcurrency('0'), /positive integer/)
})

test('validateConcurrency rejects negative numbers, non-integers, and non-numeric strings', () => {
  assert.throws(() => validateConcurrency('-1'), /positive integer/)
  assert.throws(() => validateConcurrency('3.5'), /positive integer/)
  assert.throws(() => validateConcurrency('abc'), /positive integer/)
})

test('partitionOpenAlexLookups keeps clean 200s and clean 404s as ingestable', () => {
  const lookups = [{ result: { status: 200 } }, { result: { status: 404 } }]
  const { ingestable, transientErrors } = partitionOpenAlexLookups(lookups)
  assert.equal(ingestable.length, 2)
  assert.equal(transientErrors.length, 0)
})

test('partitionOpenAlexLookups excludes transient errors (429/5xx/timeout/network) from ingestable, so they are never persisted as fake absences', () => {
  const lookups = [
    { result: { status: 429 } },
    { result: { status: 503 } },
    { result: { status: null } }, // network error / timeout
  ]
  const { ingestable, transientErrors } = partitionOpenAlexLookups(lookups)
  assert.equal(ingestable.length, 0)
  assert.equal(transientErrors.length, 3)
})

test('partitionOpenAlexLookups handles a mixed batch correctly', () => {
  const lookups = [{ result: { status: 200 } }, { result: { status: 429 } }, { result: { status: 404 } }]
  const { ingestable, transientErrors } = partitionOpenAlexLookups(lookups)
  assert.equal(ingestable.length, 2)
  assert.equal(transientErrors.length, 1)
})

test('buildExcludedIdentitySet collects identity_value from registry/excluded-identities.csv rows', () => {
  const rows = [
    { identity_type: 'issn_pair', identity_value: '2950-5771', reason: 'ghost_record_no_external_evidence' },
  ]
  const set = buildExcludedIdentitySet(rows)
  assert.ok(set.has('2950-5771'))
  assert.equal(set.size, 1)
})
