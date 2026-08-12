import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PCS_METHODOLOGY_VERSION, calculatePcs, calculatePcsCoverage } from '../src/pcs.mjs'

test('calculatePcs matches PCS-1.0-SPEC.md § 6\'s formula: sum(is_referenced_by_count) / eligible_items', () => {
  const works = [
    { document_type: 'research-article', is_referenced_by_count: 10 },
    { document_type: 'research-article', is_referenced_by_count: 20 },
    { document_type: 'research-article', is_referenced_by_count: 30 },
  ]
  const result = calculatePcs(works)
  assert.equal(result.eligible_items, 3)
  assert.equal(result.citation_count, 60)
  assert.equal(result.pcs, 20)
})

test('a work with no is_referenced_by_count (or 0) is a real data point, not missing data (PCS-1.0-SPEC.md § 7)', () => {
  // Crossref genuinely tracks 0 as "no known citing works yet" — this is
  // NOT the same as a work that failed to fetch (which must never appear
  // in the works array passed to calculatePcs() at all).
  const works = [
    { document_type: 'research-article', is_referenced_by_count: 10 },
    { document_type: 'research-article' }, // field entirely absent
    { document_type: 'research-article', is_referenced_by_count: 0 },
  ]
  const result = calculatePcs(works)
  assert.equal(result.eligible_items, 3, 'both the undefined-count and 0-count works are included in the denominator')
  assert.equal(result.citation_count, 10)
  assert.equal(Math.round(result.pcs * 1000) / 1000, Math.round((10 / 3) * 1000) / 1000)
})

test('calculatePcs reuses pci.mjs\'s isCitable() -- non-citable document types are excluded, same eligibility rule as PCI', () => {
  const works = [
    { document_type: 'research-article', is_referenced_by_count: 100 },
    { document_type: 'editorial', is_referenced_by_count: 999 }, // not citable — excluded from both numerator and denominator
    { document_type: 'correction', is_referenced_by_count: 999 },
  ]
  const result = calculatePcs(works)
  assert.equal(result.eligible_items, 1)
  assert.equal(result.citation_count, 100)
  assert.equal(result.pcs, 100)
})

test('a retracted-but-citable work stays in the PCS denominator, same rule PCI uses (PCS-1.0-SPEC.md § 10)', () => {
  const works = [
    { document_type: 'research-article', is_referenced_by_count: 5 },
    { document_type: 'research-article', retracted: true, is_referenced_by_count: 3 },
  ]
  const result = calculatePcs(works)
  assert.equal(result.eligible_items, 2, 'the retracted work is still a citable document_type, so it still counts')
  assert.equal(result.citation_count, 8, 'PCS cannot filter citations *to* a retracted work out of other works\' aggregate counts -- a disclosed limitation, not a bug (PCS-1.0-SPEC.md § 10)')
})

test('calculatePcs returns a null pcs (not divide-by-zero) with no eligible items', () => {
  const result = calculatePcs([{ document_type: 'editorial', is_referenced_by_count: 50 }])
  assert.equal(result.eligible_items, 0)
  assert.equal(result.pcs, null)
})

test('calculatePcsCoverage: fraction of enumerated in-window DOIs actually fetched, independent of document-type filtering', () => {
  assert.equal(calculatePcsCoverage(80, 100), 0.8)
  assert.equal(calculatePcsCoverage(100, 100), 1)
  assert.equal(calculatePcsCoverage(0, 100), 0)
})

test('calculatePcsCoverage returns null (not divide-by-zero) when nothing was enumerated', () => {
  assert.equal(calculatePcsCoverage(0, 0), null)
})

test('PCS_METHODOLOGY_VERSION is a stable, independent version string (PJR-SPEC.md § 11)', () => {
  assert.equal(PCS_METHODOLOGY_VERSION, 'PCS-1.0')
})
