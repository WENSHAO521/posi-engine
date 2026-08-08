import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCitable, calculatePci, calculatePnci } from '../src/pci.mjs'

test('isCitable follows the PJR-SPEC.md § 5 document-type table', () => {
  assert.equal(isCitable({ document_type: 'research-article' }), true)
  assert.equal(isCitable({ document_type: 'editorial' }), false)
  assert.equal(isCitable({ document_type: 'correction' }), false)
})

test('a retracted work STAYS in the denominator if its document_type is normally citable (PJR-SPEC.md § 7)', () => {
  // Removing a retracted work from the denominator would shrink it and
  // perversely raise the journal's PCI — the spec explicitly forbids that.
  assert.equal(isCitable({ document_type: 'research-article', retracted: true }), true)
})

test('calculatePci matches the worked example in PJR-SPEC.md § 6', () => {
  // 150 + 170 = 320 citable items receiving 1184 citations -> PCI 2027 = 3.70
  const works = [
    ...Array.from({ length: 150 }, () => ({ document_type: 'research-article', citations_in_year: 0 })),
    ...Array.from({ length: 170 }, () => ({ document_type: 'research-article', citations_in_year: 0 })),
  ]
  works[0].citations_in_year = 1184 // all citations attributed to one work for this synthetic test
  const result = calculatePci(works)
  assert.equal(result.citable_items, 320)
  assert.equal(result.citation_count, 1184)
  assert.equal(Math.round(result.ratio * 100) / 100, 3.7)
})

test('a retracted work whose citations were excluded from the numerator still counts in the denominator', () => {
  // Simulates the caller having already zeroed out citations to/from a
  // retracted work per PJR-SPEC.md § 7, while the work itself remains.
  const works = [
    ...Array.from({ length: 9 }, () => ({ document_type: 'research-article', citations_in_year: 10 })),
    { document_type: 'research-article', retracted: true, citations_in_year: 0 },
  ]
  const result = calculatePci(works)
  assert.equal(result.citable_items, 10, 'the retracted work still counts toward citable_items')
  assert.equal(result.citation_count, 90)
})

test('calculatePci returns a null ratio (not divide-by-zero) with no citable items', () => {
  const result = calculatePci([{ document_type: 'editorial', citations_in_year: 5 }])
  assert.equal(result.citable_items, 0)
  assert.equal(result.ratio, null)
})

test('calculatePnci: 1.00 means exactly at the category average', () => {
  assert.equal(calculatePnci(4.0, 4.0), 1)
  assert.equal(calculatePnci(6.0, 4.0), 1.5)
  assert.equal(calculatePnci(2.0, 4.0), 0.5)
})

test('calculatePnci returns null when there is no category baseline to compare against', () => {
  assert.equal(calculatePnci(4.0, 0), null)
  assert.equal(calculatePnci(null, 4.0), null)
})
