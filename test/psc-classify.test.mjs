import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapToPsc, classifyPsc } from '../src/psc-classify.mjs'

test('mapToPsc uses subfield overrides before falling back to field-level mapping', () => {
  assert.equal(mapToPsc('Social Sciences', 'Sociology and Political Science'), 'P5.04')
  assert.equal(mapToPsc('Social Sciences', 'Education'), 'P5.03')
  // No override for this subfield — falls back to the field-level default.
  assert.equal(mapToPsc('Social Sciences', 'Some Unmapped Subfield'), 'P5.09')
})

test('mapToPsc returns null for an unknown field', () => {
  assert.equal(mapToPsc('Not A Real OpenAlex Field', null), null)
})

test('classifyPsc aggregates by mapped PSC category, not just the single top topic', () => {
  // Three distinct OpenAlex subfields, each individually smaller than a
  // fourth unrelated topic, but all mapping to the same PSC code (P5.04)
  // should out-aggregate that fourth topic.
  const topics = [
    { count: 10, field: { display_name: 'Physics and Astronomy' }, subfield: { display_name: 'Atomic Physics' } },
    { count: 4, field: { display_name: 'Social Sciences' }, subfield: { display_name: 'Sociology and Political Science' } },
    { count: 4, field: { display_name: 'Social Sciences' }, subfield: { display_name: 'Sociology and Political Science' } },
    { count: 4, field: { display_name: 'Social Sciences' }, subfield: { display_name: 'Sociology and Political Science' } },
  ]
  const result = classifyPsc(topics, 100)
  assert.equal(result.psc_category, 'P5.04', 'the three aggregated P5.04 topics (12) outweigh the single P1.03 topic (10)')
})

test('classifyPsc flags low confidence when the winning category does not dominate', () => {
  // 10 fields at equal weight, each mapping to a DISTINCT PSC code (Medicine
  // and Dentistry, for example, both map to P3.02 and would silently
  // aggregate — verified against FIELD_TO_PSC before picking these) -> each
  // is 10% of the total, below the 15% concentration threshold.
  const fields = ['Mathematics', 'Chemistry', 'Physics and Astronomy', 'Psychology', 'Computer Science', 'Materials Science', 'Veterinary Science', 'Chemical Engineering', 'Business, Management and Accounting', 'Energy']
  const topics = fields.map(f => ({ count: 3, field: { display_name: f } }))
  const result = classifyPsc(topics, 200)
  assert.equal(result.psc_confidence, 'low', 'no category reaches the 15% concentration threshold across 10 equal-weight, distinct-PSC topics')
})

test('classifyPsc flags low confidence for a small journal even with a dominant share (regression: GRHAS)', () => {
  // Reproduces the real case that motivated the works_count gate: a small
  // journal (41 works) where a handful of dance-studies articles carried
  // enough topic-model weight to look "confidently" classified as
  // Psychology by concentration share alone (~35%), despite the journal
  // being a general humanities/arts/society title. See PSC-CROSSWALK.md § 3.
  const topics = [
    { count: 13, field: { display_name: 'Psychology' }, subfield: { display_name: 'Experimental and Cognitive Psychology' } },
    { count: 4, field: { display_name: 'Arts and Humanities' }, subfield: { display_name: 'Visual Arts and Performing Arts' } },
    { count: 4, field: { display_name: 'Psychology' }, subfield: { display_name: 'Social Psychology' } },
    { count: 3, field: { display_name: 'Social Sciences' }, subfield: { display_name: 'Cultural Studies' } },
  ]
  const result = classifyPsc(topics, 41) // below MIN_WORKS_COUNT (50)
  assert.equal(result.psc_confidence, 'low', 'a 41-work journal should not be treated as confidently classified regardless of share')
})

test('classifyPsc marks the same distribution high-confidence once works_count clears the threshold', () => {
  const topics = [
    { count: 130, field: { display_name: 'Psychology' }, subfield: { display_name: 'Experimental and Cognitive Psychology' } },
    { count: 40, field: { display_name: 'Arts and Humanities' }, subfield: { display_name: 'Visual Arts and Performing Arts' } },
  ]
  const result = classifyPsc(topics, 500)
  assert.equal(result.psc_category, 'P5.01')
  assert.equal(result.psc_confidence, 'high')
})

test('classifyPsc returns nulls for an empty or all-unmapped topics array', () => {
  assert.deepEqual(classifyPsc([], 100), { psc_category: null, psc_confidence: null })
  assert.deepEqual(
    classifyPsc([{ count: 5, field: { display_name: 'Not A Real Field' } }], 100),
    { psc_category: null, psc_confidence: null }
  )
})
