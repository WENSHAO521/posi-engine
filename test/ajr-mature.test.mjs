import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AJR_M_METHODOLOGY_VERSION,
  CITATION_PERFORMANCE_WEIGHT,
  OUTPUT_STABILITY_WEIGHT,
  GOVERNANCE_INTEGRITY_WEIGHT,
  AJRM_INFRASTRUCTURE_WEIGHT,
  AJRM_REACH_CONCENTRATION_WEIGHT,
  computeCitationPercentiles,
  scoreCitationPerformance,
  scoreFiveYearContinuity,
  scoreOutputStability,
  scoreScheduleAdherence,
  scoreOutputAndStability,
  scoreGovernanceIntegrity,
  scoreAjrMInfrastructure,
  scoreReachConcentrationMature,
  computeAjrM,
  gateAjrMByIntegrity,
  GOVERNANCE_INTEGRITY_ITEMS,
  AJRM_INFRASTRUCTURE_ITEMS,
} from '../src/ajr-mature.mjs'

test('AJR_M_METHODOLOGY_VERSION is 1.0 — this model did not exist before', () => {
  assert.equal(AJR_M_METHODOLOGY_VERSION, 'AJR-M-1.0')
})

test('all six dimension weights sum to exactly 100', () => {
  assert.equal(CITATION_PERFORMANCE_WEIGHT, 35)
  assert.equal(OUTPUT_STABILITY_WEIGHT, 20)
  assert.equal(GOVERNANCE_INTEGRITY_WEIGHT, 15)
  assert.equal(AJRM_INFRASTRUCTURE_WEIGHT, 10)
  assert.equal(AJRM_REACH_CONCENTRATION_WEIGHT, 10)
  const transparencyWeight = 10
  assert.equal(35 + 20 + 15 + 10 + 10 + transparencyWeight, 100)
})

test('GOVERNANCE_INTEGRITY_ITEMS and AJRM_INFRASTRUCTURE_ITEMS sum to their dimension weights', () => {
  assert.equal(GOVERNANCE_INTEGRITY_ITEMS.reduce((s, i) => s + i.weight, 0), 15)
  assert.equal(AJRM_INFRASTRUCTURE_ITEMS.reduce((s, i) => s + i.weight, 0), 10)
})

// ---- Dimension 1: the flagship citation-percentile dimension ----

test('computeCitationPercentiles: within-category percentile, not raw PCI value, is what feeds the score', () => {
  // 20-journal category, PCI descending 20..1 in steps of 1 for id j0..j19.
  const entries = Array.from({ length: 20 }, (_, i) => ({ journal_id: `j${i}`, pci: 20 - i, pci_5yr: 20 - i, pnci: 2.0 - i * 0.05 }))
  const top = computeCitationPercentiles(entries, 'j0')
  assert.equal(top.percentile_pci, 97.5)
  const bottom = computeCitationPercentiles(entries, 'j19')
  assert.equal(bottom.percentile_pci, 2.5)
})

test('computeCitationPercentiles returns null for a metric the journal has no value for (missing PCI-5)', () => {
  const entries = [
    { journal_id: 'a', pci: 5, pci_5yr: null, pnci: 1.2 },
    { journal_id: 'b', pci: 3, pci_5yr: 2, pnci: 0.8 },
  ]
  const result = computeCitationPercentiles(entries, 'a')
  assert.equal(result.percentile_pci5, null)
  assert.ok(result.percentile_pci != null)
})

test('scoreCitationPerformance: field normalization — a journal at the SAME percentile in a low-citation field scores identically to one in a high-citation field', () => {
  // Medicine-like category: high raw PCI values. History-like category: low
  // raw PCI values. Both journals sit at the 90th percentile within their
  // OWN category — S_PCI must be equal despite wildly different raw PCI.
  const medicineEntries = Array.from({ length: 20 }, (_, i) => ({ journal_id: `med-${i}`, pci: 50 - i * 2, pci_5yr: null, pnci: null }))
  const historyEntries = Array.from({ length: 20 }, (_, i) => ({ journal_id: `hist-${i}`, pci: 0.5 - i * 0.02, pci_5yr: null, pnci: null }))
  const medTop = computeCitationPercentiles(medicineEntries, 'med-1') // 2nd highest -> 92.5th percentile
  const histTop = computeCitationPercentiles(historyEntries, 'hist-1')
  assert.equal(medTop.percentile_pci, histTop.percentile_pci, 'same rank position -> same percentile regardless of raw PCI scale')
  const medScore = scoreCitationPerformance(medTop)
  const histScore = scoreCitationPerformance(histTop)
  assert.equal(medScore.subfactors.s_pci, histScore.subfactors.s_pci, 'field-normalized: same percentile must produce the same S_PCI regardless of which field the journal is in')
})

test('scoreCitationPerformance: 100th-percentile-equivalent on all three metrics scores the full 35', () => {
  const result = scoreCitationPerformance({ percentile_pci: 100, percentile_pci5: 100, percentile_pnci: 100 })
  assert.equal(result.score, 35)
  assert.equal(result.subfactors.s_pci, 15)
  assert.equal(result.subfactors.s_pci5, 10)
  assert.equal(result.subfactors.s_pnci, 10)
})

test('scoreCitationPerformance: missing PCI-5/PNCI data is NOT scored as zero — computable_max shrinks instead', () => {
  const result = scoreCitationPerformance({ percentile_pci: 100, percentile_pci5: null, percentile_pnci: null })
  assert.equal(result.score, 15, 'only S_PCI is computable and it is maxed out')
  assert.equal(result.computable_max, 15, 'the other 20 points were never "failed" — they were uncomputable')
})

// ---- Dimension 2 ----

test('scoreFiveYearContinuity: proportional to years with output', () => {
  assert.equal(scoreFiveYearContinuity([true, true, true, true, true]).score, 4)
  assert.equal(scoreFiveYearContinuity([true, true, false, false, false]).score, 1.6)
  assert.equal(scoreFiveYearContinuity([]).score, null)
})

test('scoreOutputStability: a perfectly steady output series scores near the max regardless of its absolute volume', () => {
  const steadySmall = scoreOutputStability([10, 10, 10, 10])
  const steadyLarge = scoreOutputStability([500, 500, 500, 500])
  assert.equal(steadySmall.score, 4)
  assert.equal(steadyLarge.score, 4, 'more articles must not itself be scored higher — only consistency matters')
})

test('scoreOutputStability: a wildly fluctuating series scores lower than a steady one', () => {
  const steady = scoreOutputStability([50, 52, 48, 51])
  const volatile = scoreOutputStability([10, 90, 15, 85])
  assert.ok(volatile.score < steady.score)
})

test('scoreScheduleAdherence tiers: >=90% full, 75-89% 80%, 60-74% 40%, <60% zero (mirrors AJR-E cadence tiers, scaled to 3 points)', () => {
  assert.equal(scoreScheduleAdherence(10, 10).score, 3)
  assert.equal(scoreScheduleAdherence(10, 8).score, 2.4)
  assert.equal(scoreScheduleAdherence(10, 6).score, 1.2)
  assert.equal(scoreScheduleAdherence(10, 5).score, 0)
})

test('scoreOutputAndStability composes to at most 20', () => {
  const result = scoreOutputAndStability({
    continuity5yr: [true, true, true, true, true],
    annualOutputCounts: [50, 51, 49, 50, 50],
    schedule: { expectedWindows: 10, metWindows: 10 },
    structuralMetadataStatus: 'met',
    depositTimelinessStatus: 'met',
    dateConsistencyStatus: 'met',
  })
  assert.ok(result.score <= 20)
  assert.ok(result.score > 15, `expected a high score for clean stable data, got ${result.score}`)
})

// ---- Dimensions 3 & 4 ----

test('scoreGovernanceIntegrity and scoreAjrMInfrastructure: fully met scores the full dimension weight', () => {
  const gov = scoreGovernanceIntegrity(Object.fromEntries(GOVERNANCE_INTEGRITY_ITEMS.map(i => [i.id, 'met'])))
  assert.equal(gov.score, 15)
  const infra = scoreAjrMInfrastructure(Object.fromEntries(AJRM_INFRASTRUCTURE_ITEMS.map(i => [i.id, 'met'])))
  assert.equal(infra.score, 10)
})

// ---- Dimension 5: severe anomalies never scored down here ----

test('scoreReachConcentrationMature has no citation-integrity input at all — severe anomalies cannot lower this dimension', () => {
  const result = scoreReachConcentrationMature({ maxAuthorShare: 0.1, maxInstitutionShare: 0.1, uniqueInstitutionRatio: 1, maxCitingSourceShare: 0.1 })
  assert.equal(result.score, 10)
  // Structural proof: the function signature has no flagged/suppressed/
  // integrity parameter at all to pass such a thing through even if a
  // caller tried.
  assert.equal(scoreReachConcentrationMature.length, 1)
})

test('scoreReachConcentrationMature tiers: institution/author concentration', () => {
  assert.equal(scoreReachConcentrationMature({ maxAuthorShare: 0.2, maxInstitutionShare: null, uniqueInstitutionRatio: null, maxCitingSourceShare: null }).subfactors.author_concentration, 3)
  assert.equal(scoreReachConcentrationMature({ maxAuthorShare: 0.7, maxInstitutionShare: null, uniqueInstitutionRatio: null, maxCitingSourceShare: null }).subfactors.author_concentration, 0)
  assert.equal(scoreReachConcentrationMature({ maxAuthorShare: null, maxInstitutionShare: 0.3, uniqueInstitutionRatio: null, maxCitingSourceShare: null }).subfactors.institution_concentration, 3)
})

// ---- Composite ----

test('computeAjrM composes all six dimensions and stamps AJR-M-1.0', () => {
  const result = computeAjrM({
    citationPercentiles: { percentile_pci: 90, percentile_pci5: 90, percentile_pnci: 90 },
    outputStability: {
      continuity5yr: [true, true, true, true, true],
      annualOutputCounts: [50, 51, 49, 50],
      schedule: { expectedWindows: 10, metWindows: 10 },
      structuralMetadataStatus: 'met',
      depositTimelinessStatus: 'met',
      dateConsistencyStatus: 'met',
    },
    governanceIntegrity: Object.fromEntries(GOVERNANCE_INTEGRITY_ITEMS.map(i => [i.id, 'met'])),
    infrastructure: Object.fromEntries(AJRM_INFRASTRUCTURE_ITEMS.map(i => [i.id, 'met'])),
    reachConcentration: { maxAuthorShare: 0.1, maxInstitutionShare: 0.1, uniqueInstitutionRatio: 0.9, maxCitingSourceShare: 0.1 },
    transparency: {
      fee_disclosure: 'met', copyright_licensing: 'met', access_model_disclosure: 'met',
      publisher_ownership_contact: 'met', author_guidelines: 'met',
      advertising_sponsorship_disclosure: 'met', other_applicable_terms: 'met',
    },
  })
  assert.equal(result.methodology_version, 'AJR-M-1.0')
  assert.ok(result.total > 80, `expected a strong composite for near-max input, got ${result.total}`)
  assert.ok(result.total <= 100)
})

test('a mature journal can score high on AJR-M citation performance while having low overall AJR-M (governance drags it down) — the composite is not a repackaged citation ranking', () => {
  const strongCitationWeakGovernance = computeAjrM({
    citationPercentiles: { percentile_pci: 100, percentile_pci5: 100, percentile_pnci: 100 },
    outputStability: { continuity5yr: [], annualOutputCounts: [], schedule: {}, structuralMetadataStatus: 'unknown', depositTimelinessStatus: 'unknown', dateConsistencyStatus: 'unknown' },
    governanceIntegrity: {},
    infrastructure: {},
    reachConcentration: {},
    transparency: {},
  })
  assert.equal(strongCitationWeakGovernance.subfactors.citation.score, 35, 'citation performance alone maxes out')
  assert.ok(strongCitationWeakGovernance.total < 60, 'but the composite must not top out just from citation performance')
})

// ---- Integrity gate ----

test('gateAjrMByIntegrity: an unflagged verdict passes the AJR-M result through unchanged', () => {
  const ajrM = { total: 88.5, methodology_version: 'AJR-M-1.0' }
  const gated = gateAjrMByIntegrity(ajrM, { flagged: false })
  assert.deepEqual(gated, { status: 'rankable', result: ajrM })
})

test('gateAjrMByIntegrity: a flagged (post-review, suppressed) verdict replaces the result — never a point deduction', () => {
  const ajrM = { total: 92.1, methodology_version: 'AJR-M-1.0' }
  const gated = gateAjrMByIntegrity(ajrM, { flagged: true, flagged_checks: ['citation_stacking'] })
  assert.equal(gated.status, 'not_officially_rankable')
  assert.deepEqual(gated.flagged_checks, ['citation_stacking'])
  assert.equal('result' in gated, false, 'no partial/deducted score object should leak through when suppressed')
})
