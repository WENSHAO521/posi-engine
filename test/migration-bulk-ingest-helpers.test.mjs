import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExistingIssnSet, validateConcurrency, partitionOpenAlexLookups, buildExcludedIdentitySet, validateIsoCountryCode } from '../src/migration/bulk-ingest-helpers.mjs'

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

test('buildExistingIssnSet also includes the kind-unspecified `issn` field', () => {
  // Bulk-publisher-catalog records with no print/online marking on their
  // source ISSN column carry it as `issn`, not `issn_online` -- this set
  // must still catch it, or a later ingest run would treat the same
  // journal as new every time.
  const set = buildExistingIssnSet([
    { issn_online: null, issn_print: null, issn: '5555-5555' },
    { issn_online: '6666-6666', issn_print: null },
  ])
  assert.ok(set.has('5555-5555'))
  assert.ok(set.has('6666-6666'))
  assert.equal(set.size, 2)
})

test('validateIsoCountryCode accepts a clean two-letter uppercase code', () => {
  assert.equal(validateIsoCountryCode('US'), 'US')
  assert.equal(validateIsoCountryCode('GB'), 'GB')
})

test('validateIsoCountryCode rejects lowercase, wrong length, non-string, null/undefined', () => {
  assert.equal(validateIsoCountryCode('us'), null)
  assert.equal(validateIsoCountryCode('USA'), null)
  assert.equal(validateIsoCountryCode('U'), null)
  assert.equal(validateIsoCountryCode(''), null)
  assert.equal(validateIsoCountryCode(null), null)
  assert.equal(validateIsoCountryCode(undefined), null)
  assert.equal(validateIsoCountryCode(123), null)
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
