import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issnChecksumValid, normalizeIssn, normalizeTitle, normalizeUrl, normalizeCountry, normalizeRecord } from '../src/migration/normalize.mjs'

test('issnChecksumValid accepts a known-real ISSN', () => {
  assert.equal(issnChecksumValid('0028-0836'), true) // Nature
})

test('issnChecksumValid rejects a tampered checksum', () => {
  assert.equal(issnChecksumValid('0028-0837'), false)
})

test('normalizeIssn flags malformed shapes distinctly from checksum failures', () => {
  const malformed = normalizeIssn('not-an-issn')
  assert.equal(malformed.valid, false)
  assert.match(malformed.warning, /malformed/)

  const badChecksum = normalizeIssn('0028-0837')
  assert.equal(badChecksum.valid, false)
  assert.match(badChecksum.warning, /checksum/)

  const good = normalizeIssn('0028-0836')
  assert.equal(good.valid, true)
  assert.equal(good.value, '0028-0836')
})

test('normalizeIssn is tolerant of stray formatting', () => {
  assert.equal(normalizeIssn(' 0028 0836 ').value, '0028-0836')
  assert.equal(normalizeIssn('0028-0836').valid, true)
})

test('normalizeTitle collapses whitespace and trims', () => {
  assert.equal(normalizeTitle('  Journal   of   Things  '), 'Journal of Things')
  assert.equal(normalizeTitle(''), null)
  assert.equal(normalizeTitle(null), null)
})

test('normalizeUrl lowercases scheme/host', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Journal'), 'https://example.com/Journal')
  assert.equal(normalizeUrl('not a url'), null)
})

test('normalizeCountry maps a common name and passes through an alpha-2 code', () => {
  assert.deepEqual(normalizeCountry('Canada'), { value: 'CA', warning: null })
  assert.deepEqual(normalizeCountry('ca'), { value: 'CA', warning: null })
  const unmapped = normalizeCountry('Atlantis')
  assert.equal(unmapped.value, null)
  assert.match(unmapped.warning, /unmapped/)
})

test('normalizeRecord flags identical print/online ISSN as a warning, not a strength', () => {
  const { normalized, warnings } = normalizeRecord({
    source_collection: 'discovered',
    legacy_id: 'j-disc-x',
    title: 'X',
    issn_print: '0028-0836',
    issn_online: '0028-0836',
  })
  assert.equal(normalized.issn_print, '0028-0836')
  assert.equal(normalized.issn_online, '0028-0836')
  assert.ok(warnings.some(w => w.includes('identical')))
})

test('normalizeRecord never throws on a mostly-empty record', () => {
  assert.doesNotThrow(() => normalizeRecord({ source_collection: 'discovered', legacy_id: 'j-disc-empty' }))
})
