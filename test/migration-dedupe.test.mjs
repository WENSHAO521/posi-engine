import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCandidateEntities } from '../src/migration/dedupe.mjs'

function rec(overrides) {
  return {
    source_collection: 'discovered',
    legacy_id: 'j-disc-x',
    title: 'X',
    short_title: null,
    issn_print: null,
    issn_online: null,
    issn_l: null,
    publisher: null,
    country: null,
    website_url: null,
    openalex_source_id: null,
    doaj_status: null,
    doaj_id: null,
    article_count: 0,
    ...overrides,
  }
}

test('two records sharing a valid ISSN merge into one candidate entity', () => {
  const records = [
    rec({ legacy_id: 'a', issn_online: '0028-0836' }),
    rec({ legacy_id: 'b', issn_print: '0028-0836' }),
  ]
  const { entities, hardConflicts } = buildCandidateEntities(records)
  assert.equal(entities.length, 1)
  assert.equal(entities[0].member_count, 2)
  assert.equal(entities[0].status, 'resolved')
  assert.equal(hardConflicts.length, 0)
})

test('two records sharing an OpenAlex id with no ISSN evidence merge safely', () => {
  const records = [
    rec({ legacy_id: 'a', openalex_source_id: 'S123' }),
    rec({ legacy_id: 'b', openalex_source_id: 'S123' }),
  ]
  const { entities } = buildCandidateEntities(records)
  assert.equal(entities.length, 1)
  assert.equal(entities[0].member_count, 2)
})

test('conflict beats match: same OpenAlex id but non-overlapping valid ISSNs does NOT merge', () => {
  const records = [
    rec({ legacy_id: 'a', openalex_source_id: 'S999', issn_online: '0028-0836' }),
    rec({ legacy_id: 'b', openalex_source_id: 'S999', issn_online: '0378-5955' }), // different real, valid ISSN
  ]
  const { entities, hardConflicts } = buildCandidateEntities(records)
  assert.equal(entities.length, 2, 'the two records must stay as separate candidate entities')
  assert.equal(hardConflicts.length, 1)
  assert.equal(hardConflicts[0].type, 'openalex_id_spans_conflicting_issn_groups')
  assert.equal(hardConflicts[0].openalex_source_id, 'S999')
})

test('title+publisher match alone never merges — surfaces as a possible duplicate instead', () => {
  const records = [
    rec({ legacy_id: 'a', title: 'Journal of Things', publisher: 'Acme' }),
    rec({ legacy_id: 'b', title: 'Journal of Things', publisher: 'Acme' }),
  ]
  const { entities, possibleDuplicates } = buildCandidateEntities(records)
  assert.equal(entities.length, 2, 'title/publisher match must not auto-merge')
  assert.equal(entities.every(e => e.status === 'unresolved'), true)
  assert.equal(possibleDuplicates.length, 1)
  assert.deepEqual(possibleDuplicates[0].legacy_ids.sort(), ['a', 'b'])
})

test('a record with no identity signals at all is its own unresolved singleton entity', () => {
  const records = [rec({ legacy_id: 'lonely', title: null, publisher: null })]
  const { entities } = buildCandidateEntities(records)
  assert.equal(entities.length, 1)
  assert.equal(entities[0].status, 'unresolved')
  assert.equal(entities[0].member_count, 1)
})

test('deterministic: running twice on the same input produces the same grouping', () => {
  const records = [
    rec({ legacy_id: 'a', issn_online: '0028-0836' }),
    rec({ legacy_id: 'b', issn_print: '0028-0836' }),
    rec({ legacy_id: 'c', openalex_source_id: 'S1' }),
    rec({ legacy_id: 'd', openalex_source_id: 'S1' }),
    rec({ legacy_id: 'e', title: 'Solo', publisher: 'Nobody' }),
  ]
  const run1 = buildCandidateEntities(records)
  const run2 = buildCandidateEntities(records)
  const shape = r => r.entities.map(e => [...e.member_legacy_ids].sort()).sort((a, b) => a.join() < b.join() ? -1 : 1)
  assert.deepEqual(shape(run1), shape(run2))
  assert.equal(run1.hardConflicts.length, run2.hardConflicts.length)
  assert.equal(run1.possibleDuplicates.length, run2.possibleDuplicates.length)
})
