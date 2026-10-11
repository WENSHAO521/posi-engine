// The directory-sync glue: export posi-data's discovered journals as site-shaped records, apply a changed
// copy back. Needs a posi-data checkout with scripts/, journals/, screening/ and registry/ in
// POSI_DATA_DIR (the Test workflow checks one out); skipped without it. Works on a copy, never the checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSiteRecords } from '../scripts/directory/export-site-records.mjs'
import { applyRecords } from '../scripts/directory/apply-site-records.mjs'

const src = process.env.POSI_DATA_DIR
const ok = src && existsSync(join(src, 'screening/discovered-screening.jsonl')) && existsSync(join(src, 'scripts/lib/compose-discovered.mjs'))

function issnWithCheckDigit(taken) {
  for (let n = 2000001; ; n += 7) {
    const d = String(n).padStart(7, '0')
    let t = 0; for (let i = 0; i < 7; i++) t += Number(d[i]) * (8 - i)
    const c = (11 - (t % 11)) % 11
    const s = `${d.slice(0, 4)}-${d.slice(4)}${c === 10 ? 'X' : c}`
    if (!taken.includes(s)) return s
  }
}

test('an unchanged export applies as no change', { skip: !ok }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'posi-data-'))
  for (const d of ['scripts', 'journals', 'screening', 'registry', 'schema']) cpSync(join(src, d), join(dir, d), { recursive: true })
  const baseline = await exportSiteRecords(dir)
  const s = await applyRecords({ data: dir, baseline, records: structuredClone(baseline) })
  assert.deepEqual(s, { screening_updated: 0, filled: 0, proposed: 0, new_candidates: 0, minted: 0, new_screening: 0, held_for_review: 0, unchanged: baseline.length })
})

test('screening changes are written, a changed title is only proposed, a new journal is minted and screened', { skip: !ok, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'posi-data-'))
  for (const d of ['scripts', 'journals', 'screening', 'registry', 'schema']) cpSync(join(src, d), join(dir, d), { recursive: true })
  const baseline = await exportSiteRecords(dir)
  const records = structuredClone(baseline)
  records[10].metadata_quality_score = (records[10].metadata_quality_score ?? 0) + 1
  records[11].article_count = (records[11].article_count ?? 0) + 5
  const oldTitle = records[12].title
  records[12].title = `${oldTitle} (changed)`
  const registry = readFileSync(join(dir, 'registry/journal-id-map.csv'), 'utf8')
  const issn = issnWithCheckDigit([registry])
  records.push({ ...records[0], id: `j-disc-issn-${issn}`, journal_code: `issn-${issn}`, title: 'Round Trip Test Journal', issn_online: issn, issn_print: null, openalex_source_id: null, publisher: 'Test Press', doaj_status: 'listed' })
  const s = await applyRecords({ data: dir, baseline, records, today: '2026-10-12' })
  assert.equal(s.screening_updated, 2)
  assert.equal(s.proposed, 1)
  assert.equal(s.minted, 1)
  assert.equal(s.new_screening, 1)
  const after = await exportSiteRecords(dir)
  assert.equal(after.length, baseline.length + 1)
  assert.equal(after.find((r) => r.journal_code === records[12].journal_code).title, oldTitle)   // the title did not change
  assert.equal(after.find((r) => r.journal_code === `issn-${issn}`).title, 'Round Trip Test Journal')
  assert.equal(after.find((r) => r.id === records[10].id).metadata_quality_score, records[10].metadata_quality_score)
  const again = await applyRecords({ data: dir, baseline: after, records: structuredClone(after) })
  assert.equal(again.screening_updated + again.minted + again.new_screening, 0)
})
