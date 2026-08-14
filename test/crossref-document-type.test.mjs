import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapCrossrefType, CROSSREF_TYPE_TO_DOCUMENT_TYPE, CROSSREF_TYPES_EXCLUDED } from '../src/crossref-document-type.mjs'
import { isCitable } from '../src/pci.mjs'

test('mapCrossrefType: journal-article -> research-article (citable)', () => {
  assert.equal(mapCrossrefType('journal-article'), 'research-article')
  assert.ok(isCitable({ document_type: mapCrossrefType('journal-article') }))
})

test('mapCrossrefType: structural container records (journal/journal-issue/journal-volume) have no analog -> null', () => {
  assert.equal(mapCrossrefType('journal'), null)
  assert.equal(mapCrossrefType('journal-issue'), null)
  assert.equal(mapCrossrefType('journal-volume'), null)
})

test('mapCrossrefType: non-journal content types (books, proceedings, datasets, ...) have no analog -> null', () => {
  for (const t of ['proceedings-article', 'book-chapter', 'dataset', 'dissertation', 'report', 'standard', 'grant', 'peer-review', 'posted-content', 'other']) {
    assert.equal(mapCrossrefType(t), null, `${t} should map to null`)
  }
})

test('mapCrossrefType: null/undefined input -> null, not a thrown error', () => {
  assert.equal(mapCrossrefType(null), null)
  assert.equal(mapCrossrefType(undefined), null)
})

test('mapCrossrefType: an unrecognized/future Crossref type -> null (excluded, not guessed)', () => {
  assert.equal(mapCrossrefType('some-brand-new-crossref-type-2030'), null)
})

test('CROSSREF_TYPE_TO_DOCUMENT_TYPE only ever maps to a real PJR-SPEC document_type value', () => {
  const validDocTypes = new Set([
    'research-article', 'review-article', 'systematic-review', 'meta-analysis', 'data-article',
    'editorial', 'letter', 'correction', 'retraction-notice', 'news', 'book-review', 'meeting-abstract',
  ])
  for (const v of Object.values(CROSSREF_TYPE_TO_DOCUMENT_TYPE)) {
    assert.ok(validDocTypes.has(v), `${v} must be a real PJR-SPEC document_type`)
  }
})

test('no Crossref type appears in both the mapping and the excluded set', () => {
  for (const t of Object.keys(CROSSREF_TYPE_TO_DOCUMENT_TYPE)) {
    assert.ok(!CROSSREF_TYPES_EXCLUDED.has(t), `${t} must not be in both places`)
  }
})
