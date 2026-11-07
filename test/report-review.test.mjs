import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from '../scripts/directory/report-review.mjs'

test('nothing to review gives no report', () => {
  assert.equal(buildReport({ proposedCsv: 'journal_code,field,before,after\n', review: { quarantined: [], conflicts: [], title_overlaps: [] } }), null)
})

test('lists proposed changes and held journals', () => {
  const r = buildReport({
    proposedCsv: 'journal_code,field,before,after\nj-1,issn_print,"1234-5678","2345-6789"\n',
    review: { quarantined: [], conflicts: [], title_overlaps: [{ title: 'Revista X', candidates: [{ issns: ['0717-2257'], publisher: 'U' }], existing_ids: ['POSI-J-1'] }] },
  })
  assert.match(r, /\| j-1 \| issn_print \| 1234-5678 \| 2345-6789 \|/)
  assert.match(r, /Revista X\*\*: 0717-2257 \(U\); same title as POSI-J-1/)
})
