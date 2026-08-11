import { test } from 'node:test'
import assert from 'node:assert/strict'
import { determinePqfStatus, validatePqfPublicLabel, PQF_STATUSES } from '../src/pqf.mjs'

test('PQF_STATUSES is exactly the four allowed values', () => {
  assert.deepEqual(PQF_STATUSES, ['Eligible', 'Review Required', 'Insufficient Evidence', 'Not Eligible'])
})

test('determinePqfStatus: strong evidence, no flags, no integrity issue -> Eligible', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 95, mandatoryEvidenceResolved: true, hasUnresolvedSevereIntegrityFinding: false, reviewFlagged: false })
  assert.equal(status, 'Eligible')
})

test('determinePqfStatus: mandatory evidence missing -> Insufficient Evidence, even at high EC%', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 95, mandatoryEvidenceResolved: false, hasUnresolvedSevereIntegrityFinding: false, reviewFlagged: false })
  assert.equal(status, 'Insufficient Evidence')
})

test('determinePqfStatus: EC% below 60 -> Insufficient Evidence', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 45, mandatoryEvidenceResolved: true, hasUnresolvedSevereIntegrityFinding: false, reviewFlagged: false })
  assert.equal(status, 'Insufficient Evidence')
})

test('determinePqfStatus: an unresolved severe integrity finding -> Not Eligible, even with good evidence coverage', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 90, mandatoryEvidenceResolved: true, hasUnresolvedSevereIntegrityFinding: true, reviewFlagged: false })
  assert.equal(status, 'Not Eligible')
})

test('determinePqfStatus: provisional-range coverage (60-79.99) -> Review Required', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 70, mandatoryEvidenceResolved: true, hasUnresolvedSevereIntegrityFinding: false, reviewFlagged: false })
  assert.equal(status, 'Review Required')
})

test('determinePqfStatus: explicitly flagged for review overrides an otherwise-Eligible EC%', () => {
  const status = determinePqfStatus({ evidenceCoveragePercent: 95, mandatoryEvidenceResolved: true, hasUnresolvedSevereIntegrityFinding: false, reviewFlagged: true })
  assert.equal(status, 'Review Required')
})

test('determinePqfStatus never returns anything outside the four-value enum, across a wide input sweep', () => {
  for (const ec of [0, 10, 30, 59, 60, 70, 79, 80, 95, 100]) {
    for (const mandatory of [true, false]) {
      for (const integrity of [true, false]) {
        for (const flagged of [true, false]) {
          const status = determinePqfStatus({ evidenceCoveragePercent: ec, mandatoryEvidenceResolved: mandatory, hasUnresolvedSevereIntegrityFinding: integrity, reviewFlagged: flagged })
          assert.ok(PQF_STATUSES.includes(status), `unexpected PQF status "${status}" for ec=${ec} mandatory=${mandatory} integrity=${integrity} flagged=${flagged}`)
        }
      }
    }
  }
})

test('validatePqfPublicLabel accepts the four canonical statuses', () => {
  for (const s of PQF_STATUSES) assert.deepEqual(validatePqfPublicLabel(s), { valid: true, reason: null })
})

test('validatePqfPublicLabel rejects ranking-shaped labels ("PQF Q1", "A+ Journal", "PQF Ranking")', () => {
  assert.equal(validatePqfPublicLabel('PQF Q1').valid, false)
  assert.equal(validatePqfPublicLabel('A+ Journal').valid, false)
  assert.equal(validatePqfPublicLabel('PQF Ranking: Top Tier').valid, false)
  assert.ok(validatePqfPublicLabel('PQF Q1').reason.includes('ranking'))
})

test('validatePqfPublicLabel rejects an unrecognized non-ranking-shaped string too', () => {
  const result = validatePqfPublicLabel('Pending Review')
  assert.equal(result.valid, false)
  assert.ok(result.reason.includes('not one of the four allowed'))
})
