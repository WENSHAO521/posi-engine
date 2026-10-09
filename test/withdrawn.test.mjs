import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isWithdrawn, withoutWithdrawn } from '../src/withdrawn.mjs'

const root = new URL('..', import.meta.url).pathname

test('isWithdrawn: only collection_status "withdrawn"', () => {
  assert.equal(isWithdrawn({ collection_status: 'withdrawn' }), true)
  for (const s of [undefined, null, 'core', 'discovered', 'suspended', 'ceased']) assert.equal(isWithdrawn({ collection_status: s }), false, String(s))
  assert.equal(isWithdrawn(null), false)
  assert.equal(isWithdrawn(undefined), false)
})

test('withoutWithdrawn: keeps the order of the others and does not change the input', () => {
  const list = [{ id: 'a' }, { id: 'b', collection_status: 'withdrawn' }, { id: 'c', collection_status: 'core' }]
  const kept = withoutWithdrawn(list, 'test')
  assert.deepEqual(kept.map(j => j.id), ['a', 'c'])
  assert.equal(list.length, 3)
})

function tempCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'withdrawn-'))
  const active = { id: 'j-a', journal_code: 'a', posi_id: 'POSI-J-000001', title: 'Active', issn_online: '1111-1111', early_stage_rating: { first_published: '2024-01-01' } }
  const withdrawn = { id: 'j-w', journal_code: 'w', posi_id: 'POSI-J-000002', title: 'Withdrawn', issn_online: '2222-2222', collection_status: 'withdrawn', early_stage_rating: { first_published: '2024-01-01', note: 'untouched' } }
  const corpus = join(dir, 'corpus.json')
  writeFileSync(corpus, JSON.stringify([active, withdrawn], null, 2))
  mkdirSync(join(dir, 'evj')); mkdirSync(join(dir, 'evw'))
  return { dir, corpus, active, withdrawn }
}

test('the AJR-E rerate rates an active journal and writes a withdrawn record back as it is', () => {
  const { dir, corpus, withdrawn } = tempCorpus()
  const out = join(dir, 'out.json')
  execFileSync('node', [join(root, 'scripts/rerate-core-collection-ajr-e-1.1.mjs'),
    '--corpus', corpus, '--evidence-journals', join(dir, 'evj'), '--evidence-works', join(dir, 'evw'),
    '--out-corpus', out, '--out-report', join(dir, 'report'), '--rating-date', '2026-10-09'], { encoding: 'utf-8' })
  const result = JSON.parse(readFileSync(out, 'utf-8'))
  assert.equal(result.length, 2, 'the withdrawn record stays in the corpus')
  assert.deepEqual(result[1], withdrawn, 'the withdrawn record is unchanged')
  assert.equal(result[0].early_stage_rating.version, 'AJR-E-1.2', 'the active journal was rated')
  const summary = JSON.parse(readFileSync(join(dir, 'report', 'rerate-summary.json'), 'utf-8'))
  assert.equal(summary.withdrawn_skipped, 1)
  const csv = readFileSync(join(dir, 'report', 'per-journal-comparison.csv'), 'utf-8')
  assert.ok(!csv.includes('POSI-J-000002'), 'the withdrawn journal is not in the comparison report')
})
