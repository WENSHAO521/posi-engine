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

test('rate-mature builds its peer sets without the withdrawn journal\'s ranking and PCI records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'withdrawn-mature-'))
  const mature = { id: 'j-a', journal_code: 'a', posi_id: 'POSI-J-000001', title: 'Active', early_stage_rating: { first_published: '2000-01-01' } }
  const withdrawn = { id: 'j-w', journal_code: 'w', posi_id: 'POSI-J-000002', title: 'Withdrawn', collection_status: 'withdrawn', early_stage_rating: { first_published: '2000-01-01' } }
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify([mature, withdrawn]))
  writeFileSync(join(dir, 'rank.json'), JSON.stringify({ records: [
    { journal_id: 'POSI-J-000001', pnci: 1, ranking_category_id: 'P1.01', citation_ranking_status: 'official' },
    { journal_id: 'POSI-J-000002', pnci: 2, ranking_category_id: 'P1.01', citation_ranking_status: 'official' },
  ] }))
  writeFileSync(join(dir, 'pci.json'), JSON.stringify([
    { journal_id: 'POSI-J-000001', pci: 1, pci_5yr: 1 }, { journal_id: 'POSI-J-000002', pci: 2, pci_5yr: 2 },
  ]))
  for (const d of ['evj', 'evw', 'evo']) mkdirSync(join(dir, d))
  const stdout = execFileSync('node', [join(root, 'scripts/rate-mature.mjs'),
    '--corpus', join(dir, 'corpus.json'), '--evidence-journals', join(dir, 'evj'), '--evidence-works', join(dir, 'evw'), '--evidence-output', join(dir, 'evo'),
    '--citation-ranking', join(dir, 'rank.json'), '--pci', join(dir, 'pci.json'),
    '--out-corpus', join(dir, 'out.json'), '--out-report', join(dir, 'report'), '--rating-date', '2026-10-09'], { encoding: 'utf-8' })
  assert.match(stdout, /Loaded 2 journals, 1 ranking records, 1 PCI records/, 'the withdrawn journal\'s two records are left out')
  const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8'))
  assert.deepEqual(out[1], withdrawn, 'and its own record is unchanged')
})

test('sample-corpus never draws a withdrawn journal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'withdrawn-sample-'))
  const j = (n, over = {}) => ({ posi_id: `POSI-J-00000${n}`, title: `J${n}`, website_url: `https://h${n}.example.com`, early_stage_rating: { first_published: '2024-01-01' }, ...over })
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify([j(1), j(2, { collection_status: 'withdrawn' }), j(3)]))
  execFileSync('node', [join(root, 'scripts/sample-corpus.mjs'), '--corpus', join(dir, 'corpus.json'), '--n', '3', '--out', join(dir, 'sample.json'), '--date', '2026-10-09'], { encoding: 'utf-8' })
  const sample = JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf-8'))
  assert.deepEqual(sample.map(x => x.posi_id).sort(), ['POSI-J-000001', 'POSI-J-000003'], 'all seats go to journals that can be crawled')
})
