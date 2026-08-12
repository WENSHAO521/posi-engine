import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  monthsSince,
  classifyLifecycleStage,
  classifyLifecycleStageByDate,
  classifyLifecycle,
  addMonthsUtc,
  LIFECYCLE_METHODOLOGY_VERSION,
} from '../src/lifecycle.mjs'

test('monthsSince computes whole calendar months elapsed (diagnostic only)', () => {
  assert.equal(monthsSince('2026-02-09', new Date('2026-08-09')), 6)
  // LIFECYCLE-1.1: monthsSince is now day-of-month-aware (see module header)
  // — 2024-01-15 to 2026-08-09 is 30 full elapsed calendar months, not 31,
  // because day 9 hasn't reached day 15 yet in the target month. The old
  // LIFECYCLE-1.0 value (31) came from year/month-only subtraction with no
  // day check at all, the same class of imprecision that caused the
  // Aug-31-vs-Aug-1 stage-boundary bug this version fixes.
  assert.equal(monthsSince('2024-01-15', new Date('2026-08-09')), 30)
})

test('classifyLifecycleStage (deprecated months-based) boundaries match the 0-11/12-59/60+ table', () => {
  assert.equal(classifyLifecycleStage(0), 'observation')
  assert.equal(classifyLifecycleStage(11), 'observation')
  assert.equal(classifyLifecycleStage(12), 'early_stage')
  assert.equal(classifyLifecycleStage(59), 'early_stage')
  assert.equal(classifyLifecycleStage(60), 'mature')
  assert.equal(classifyLifecycleStage(200), 'mature')
})

test('classifyLifecycleStage treats null/negative months as unknown', () => {
  assert.equal(classifyLifecycleStage(null), 'unknown')
  assert.equal(classifyLifecycleStage(-3), 'unknown')
})

test('classifyLifecycle returns unknown with no months when first-published date is missing', () => {
  assert.deepEqual(classifyLifecycle(null, new Date('2026-08-09')), {
    months_since_launch: null,
    lifecycle_stage: 'unknown',
    methodology_version: LIFECYCLE_METHODOLOGY_VERSION,
  })
})

test('classifyLifecycle end-to-end: Nature (first published 1869) is mature', () => {
  const result = classifyLifecycle('1869-11-01', new Date('2026-08-09'))
  assert.equal(result.lifecycle_stage, 'mature')
  assert.ok(result.months_since_launch > 1800)
})

test('classifyLifecycle end-to-end: a journal 16 months old is early_stage', () => {
  const result = classifyLifecycle('2025-04-01', new Date('2026-08-09'))
  assert.equal(result.months_since_launch, 16)
  assert.equal(result.lifecycle_stage, 'early_stage')
})

// ---- LIFECYCLE-1.1: exact date-boundary arithmetic regression tests ----
// The framework's own worked example: a journal launched Aug 31 must not be
// misjudged as 12 months old on Aug 1 of the next year (only ~11 months and
// one day have actually elapsed; calendar-month subtraction wrongly said 12).

test('addMonthsUtc adds calendar months in UTC', () => {
  assert.equal(addMonthsUtc(new Date(Date.UTC(2025, 7, 31)), 1).toISOString().slice(0, 10), '2025-10-01', 'JS Date overflow semantics for a day that does not exist in the target month')
  assert.equal(addMonthsUtc(new Date(Date.UTC(2025, 0, 15)), 12).toISOString().slice(0, 10), '2026-01-15')
})

test('regression: a journal launched 2025-08-31 is NOT yet Early-Stage on 2026-08-01 (the Aug-31-vs-Aug-1 boundary bug)', () => {
  // Old calendar-month-subtraction logic: getMonth() Aug(7) - Aug(7) = 0,
  // getFullYear() 2026-2025 = 1 => 12 months => wrongly early_stage.
  // Correct: launch + 12 months = 2026-08-31; 2026-08-01 is BEFORE that => observation.
  const stage = classifyLifecycleStageByDate('2025-08-31', new Date('2026-08-01'))
  assert.equal(stage, 'observation')
})

test('the same journal IS Early-Stage once the exact 12-month boundary (2026-08-31) has passed', () => {
  assert.equal(classifyLifecycleStageByDate('2025-08-31', new Date('2026-08-31')), 'early_stage')
  assert.equal(classifyLifecycleStageByDate('2025-08-31', new Date('2026-08-30')), 'observation')
})

test('classifyLifecycleStageByDate: exact boundaries for Early-Stage -> Mature (60 months)', () => {
  assert.equal(classifyLifecycleStageByDate('2020-01-15', new Date('2025-01-15')), 'mature', 'exactly 60 months elapsed is Mature (boundary is inclusive of "otherwise")')
  assert.equal(classifyLifecycleStageByDate('2020-01-15', new Date('2025-01-14')), 'early_stage', 'one day before the 60-month boundary is still Early-Stage')
})

test('classifyLifecycleStageByDate returns unknown for missing or future-relative launch dates', () => {
  assert.equal(classifyLifecycleStageByDate(null, new Date('2026-08-09')), 'unknown')
  assert.equal(classifyLifecycleStageByDate('2027-01-01', new Date('2026-08-09')), 'unknown')
})

test('classifyLifecycle uses the exact-date boundary (classifyLifecycleStageByDate), not calendar-month counting, and stamps methodology_version', () => {
  const result = classifyLifecycle('2025-08-31', new Date('2026-08-01'))
  assert.equal(result.lifecycle_stage, 'observation', 'must use exact-date logic, matching the regression test above')
  assert.equal(result.months_since_launch, 11, 'diagnostic month count: day-of-month-aware calendar subtraction (2026-08-01 has not reached day 31, so only 11 full calendar months have elapsed since 2025-08-31)')
  assert.equal(result.methodology_version, 'LIFECYCLE-1.1')
})
