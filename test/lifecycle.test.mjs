import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthsSince, classifyLifecycleStage, classifyLifecycle } from '../src/lifecycle.mjs'

test('monthsSince computes whole calendar months elapsed', () => {
  assert.equal(monthsSince('2026-02-09', new Date('2026-08-09')), 6)
  assert.equal(monthsSince('2024-01-15', new Date('2026-08-09')), 31)
})

test('classifyLifecycleStage boundaries match AJR-SPEC.md § 1 exactly', () => {
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
  assert.deepEqual(classifyLifecycle(null, new Date('2026-08-09')), { months_since_launch: null, lifecycle_stage: 'unknown' })
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
