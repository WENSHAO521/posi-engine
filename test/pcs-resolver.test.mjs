import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCrossrefWorkForPcs, isInPcsWindow, pcsWindowForMetricYear } from '../src/pcs-resolver.mjs'
import { calculatePcs } from '../src/pcs.mjs'

test('normalizeCrossrefWorkForPcs: maps a real-shaped Crossref journal-article into calculatePcs() input shape', () => {
  const raw = { DOI: '10.1021/jacs.3c01403', type: 'journal-article', 'is-referenced-by-count': 5, published: { 'date-parts': [[2023, 2, 8]] } }
  const work = normalizeCrossrefWorkForPcs(raw)
  assert.equal(work.doi, '10.1021/jacs.3c01403')
  assert.equal(work.document_type, 'research-article')
  assert.equal(work.is_referenced_by_count, 5)
  assert.equal(work.published_year, 2023)
})

test('normalizeCrossrefWorkForPcs: is-referenced-by-count absent -> null (distinct from an explicit 0), preserved per PCS-1.0-SPEC.md § 7', () => {
  const raw = { DOI: '10.1/x', type: 'journal-article', published: { 'date-parts': [[2024]] } }
  const work = normalizeCrossrefWorkForPcs(raw)
  assert.equal(work.is_referenced_by_count, null)
})

test('normalizeCrossrefWorkForPcs: is-referenced-by-count explicit 0 stays 0, not coerced to null', () => {
  const raw = { DOI: '10.1/x', type: 'journal-article', 'is-referenced-by-count': 0, published: { 'date-parts': [[2024]] } }
  const work = normalizeCrossrefWorkForPcs(raw)
  assert.equal(work.is_referenced_by_count, 0)
})

test('normalizeCrossrefWorkForPcs: falls back to issued date when published is absent', () => {
  const raw = { DOI: '10.1/x', type: 'journal-article', issued: { 'date-parts': [[2022, 6]] } }
  const work = normalizeCrossrefWorkForPcs(raw)
  assert.equal(work.published_year, 2022)
})

test('normalizeCrossrefWorkForPcs: a structural journal-issue record normalizes to a null document_type (excluded downstream by isCitable)', () => {
  const raw = { DOI: '10.1/issue', type: 'journal-issue', published: { 'date-parts': [[2023]] } }
  const work = normalizeCrossrefWorkForPcs(raw)
  assert.equal(work.document_type, null)
})

test('pcsWindowForMetricYear: Y-4 through Y-1, matching PCS-1.0-SPEC.md § 5\'s worked example (2026 -> 2022-2025)', () => {
  assert.deepEqual(pcsWindowForMetricYear(2026), { startYear: 2022, endYear: 2025 })
})

test('isInPcsWindow: in-range published_year is included, out-of-range is not, null is not', () => {
  const { startYear, endYear } = pcsWindowForMetricYear(2026)
  assert.equal(isInPcsWindow({ published_year: 2022 }, startYear, endYear), true)
  assert.equal(isInPcsWindow({ published_year: 2025 }, startYear, endYear), true)
  assert.equal(isInPcsWindow({ published_year: 2021 }, startYear, endYear), false)
  assert.equal(isInPcsWindow({ published_year: 2026 }, startYear, endYear), false)
  assert.equal(isInPcsWindow({ published_year: null }, startYear, endYear), false)
})

test('end-to-end: normalizeCrossrefWorkForPcs output feeds calculatePcs() directly without further reshaping', () => {
  const rawWorks = [
    { DOI: '10.1/a', type: 'journal-article', 'is-referenced-by-count': 10, published: { 'date-parts': [[2023]] } },
    { DOI: '10.1/b', type: 'journal-article', 'is-referenced-by-count': 0, published: { 'date-parts': [[2024]] } },
    { DOI: '10.1/issue', type: 'journal-issue', published: { 'date-parts': [[2024]] } },
  ]
  const normalized = rawWorks.map(normalizeCrossrefWorkForPcs)
  const result = calculatePcs(normalized)
  assert.equal(result.eligible_items, 2, 'the journal-issue record is excluded, not counted as a 0-citation article')
  assert.equal(result.citation_count, 10)
  assert.equal(result.pcs, 5)
})
