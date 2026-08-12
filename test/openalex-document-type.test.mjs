import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapOpenAlexType, isOpenAlexTypeCitable } from '../src/openalex-document-type.mjs'
import { isCitable } from '../src/pci.mjs'

test('mapOpenAlexType maps direct-analog types', () => {
  assert.equal(mapOpenAlexType('article'), 'research-article')
  assert.equal(mapOpenAlexType('review'), 'review-article')
  assert.equal(mapOpenAlexType('editorial'), 'editorial')
  assert.equal(mapOpenAlexType('letter'), 'letter')
  assert.equal(mapOpenAlexType('erratum'), 'correction')
  assert.equal(mapOpenAlexType('retraction'), 'retraction-notice')
  assert.equal(mapOpenAlexType('book-review'), 'book-review')
  assert.equal(mapOpenAlexType('news'), 'news')
})

test('mapOpenAlexType returns null for types with no PJR-SPEC analog, not a guess', () => {
  assert.equal(mapOpenAlexType('dataset'), null)
  assert.equal(mapOpenAlexType('paratext'), null)
  assert.equal(mapOpenAlexType('peer-review'), null)
})

test('mapOpenAlexType returns null for an unrecognized/future OpenAlex type', () => {
  assert.equal(mapOpenAlexType('some-new-openalex-type-2030'), null)
})

test('mapOpenAlexType returns null for null/undefined input', () => {
  assert.equal(mapOpenAlexType(null), null)
  assert.equal(mapOpenAlexType(undefined), null)
})

test('isOpenAlexTypeCitable agrees with pci.mjs isCitable() for every mapped type', () => {
  for (const t of ['article', 'review', 'editorial', 'letter', 'erratum', 'retraction', 'book-review', 'news']) {
    const mapped = mapOpenAlexType(t)
    assert.equal(isOpenAlexTypeCitable(t), isCitable({ document_type: mapped }), `mismatch for OpenAlex type "${t}"`)
  }
})

test('isOpenAlexTypeCitable is false for excluded/unmapped types', () => {
  assert.equal(isOpenAlexTypeCitable('dataset'), false)
  assert.equal(isOpenAlexTypeCitable('paratext'), false)
  assert.equal(isOpenAlexTypeCitable(null), false)
})
