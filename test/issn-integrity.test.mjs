import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issnIntegrityFindings, findingKey, journalCodeAliasConflicts, parseOpenIssues } from '../src/issn-integrity.mjs'

const rec = (id, identifiers) => ({ id, identifiers })

test('a wrong check digit is reported with its field', () => {
  const f = issnIntegrityFindings([rec('POSI-J-1', { issn_print: '1234-988X', issn_online: '0028-0836' })])
  assert.deepEqual(f, [{ kind: 'checksum', issn: '1234-988X', ids: ['POSI-J-1'], field: 'issn_print' }])
})

test('one journal holding the same ISSN in several fields is not a collision', () => {
  assert.deepEqual(issnIntegrityFindings([rec('POSI-J-1', { issn_l: '0028-0836', issn_online: '0028-0836' })]), [])
})

test('an ISSN on two live ids is reported (regression: Frontiers in Environmental Science carried 2813-5067)', () => {
  const f = issnIntegrityFindings([
    rec('POSI-J-000143', { issn_l: '2296-665X', issn_online: '2813-5067' }),
    rec('POSI-J-000173', { issn_l: '2813-5067', issn_online: '2813-5067' }),
  ])
  assert.deepEqual(f, [{ kind: 'shared', issn: '2813-5067', ids: ['POSI-J-000143', 'POSI-J-000173'] }])
})

test('a superseded id may share ISSNs with the id that replaced it', () => {
  const records = [rec('POSI-J-000091', { issn_l: '2192-8584' }), rec('POSI-J-026386', { issn_l: '2192-8584' })]
  assert.deepEqual(issnIntegrityFindings(records, new Set(['POSI-J-026386'])), [])
})

test('legacy aliases cannot shadow a current journal code or redirect to two journals', () => {
  const old = { posi_id: 'POSI-J-001546', journal_code: 'issn-2077-1770', journal_code_aliases: ['issn-3033-5981', 'old-code'] }
  const current = { posi_id: 'POSI-J-028800', journal_code: 'issn-3033-5981', journal_code_aliases: ['old-code'] }

  assert.deepEqual(journalCodeAliasConflicts([old, current]), [
    'alias issn-3033-5981 on POSI-J-001546 is a current journal_code on POSI-J-028800',
    'alias old-code on POSI-J-028800 is already listed on POSI-J-001546',
  ])
  assert.deepEqual(journalCodeAliasConflicts([
    { ...old, journal_code_aliases: ['old-code'] },
    { ...current, journal_code_aliases: [] },
  ]), [])
})

test('the review queue matches findings regardless of id order', () => {
  const queue = parseOpenIssues('kind,issn,posi_ids,note\nshared,2813-5067,"POSI-J-000173 POSI-J-000143",x\nchecksum,1234-988X,POSI-J-003175,y\n')
  assert.ok(queue.has(findingKey({ kind: 'shared', issn: '2813-5067', ids: ['POSI-J-000143', 'POSI-J-000173'] })))
  assert.ok(queue.has(findingKey({ kind: 'checksum', issn: '1234-988X', ids: ['POSI-J-003175'] })))
  assert.ok(!queue.has(findingKey({ kind: 'checksum', issn: '0000-0000', ids: ['POSI-J-9'] })))
})
