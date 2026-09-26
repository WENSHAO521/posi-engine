#!/usr/bin/env node
/**
 * run-pcs-q.mjs — builds a PCS-Q ranking edition (posi-data/PCS-Q-1.0-SPEC.md)
 * from PCS snapshot records plus the corpus records that carry each
 * journal's PSC classification.
 *
 * Inputs
 *   --pcs <file>       PCS records: a JSON array in the published snapshot
 *                      shape ({ journal_id, pcs, pcs_eligible_items,
 *                      pcs_coverage, metric_year, ... }), e.g.
 *                      posi-data-delivery collections/pcs.json, or the
 *                      global pipeline's pcs output. Repeatable.
 *   --pcs-dir <dir>    Alternatively (or additionally), a run-pcs-etl.mjs
 *                      output directory: every <dir>/pcs/<shard>/<id>.json
 *                      is read. Repeatable.
 *   --corpus <file>    Corpus JSON arrays with posi_id + psc_category +
 *                      psc_confidence (citation_preview.* is used as a
 *                      fallback for publisher-catalog records). Repeatable.
 *   --out <dir>        Output directory.
 *   [--metric-year Y]  Defaults to the metric_year found in the PCS records.
 *
 * Outputs (in --out)
 *   pcs-q-<Y>.json     { methodology_version, metric_year, generated_at,
 *                        inputs, records: [...] } — one record per journal
 *   pcs-q-<Y>.csv      same, flat
 *   summary.json       counts by outcome, category sizes
 *
 * Deterministic: same inputs, same bytes (apart from generated_at).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'
import { createHash } from 'crypto'
import { rankPcsTrack, PCS_Q_METHODOLOGY_VERSION, PCS_Q_MIN_ITEMS, PCS_Q_MIN_COVERAGE, MIN_CATEGORY_SIZE } from '../src/pcs-quartile.mjs'

function args(name) {
  const out = []
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1])
  return out
}
const arg = (name, fallback = null) => args(name)[0] ?? fallback

const pcsPaths = args('pcs').filter(Boolean)
const pcsDirs = args('pcs-dir').filter(Boolean)

function shardFiles(dir) {
  const root = existsSync(join(dir, 'pcs')) ? join(dir, 'pcs') : dir
  const out = []
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    if (statSync(p).isDirectory()) out.push(...shardFiles(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out
}
const corpusPaths = args('corpus').filter(Boolean)
const outDir = arg('out')
if ((!pcsPaths.length && !pcsDirs.length) || !outDir) {
  console.error('Usage: node scripts/run-pcs-q.mjs (--pcs <pcs.json> | --pcs-dir <etl out>) [...] --corpus <corpus.json> [--corpus ...] --out <dir> [--metric-year 2026]')
  process.exit(1)
}

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const readJson = p => {
  const raw = JSON.parse(readFileSync(resolve(p), 'utf-8'))
  return Array.isArray(raw) ? raw : raw.records ?? raw.journals ?? []
}

// PCS records, keyed by journal id (later files win for the same id).
const pcsById = new Map()
for (const p of pcsPaths) for (const r of readJson(p)) pcsById.set(r.journal_id, r)
for (const d of pcsDirs) for (const f of shardFiles(d)) { const r = JSON.parse(readFileSync(f, 'utf-8')); pcsById.set(r.journal_id, r) }
const years = [...new Set([...pcsById.values()].map(r => r.metric_year).filter(Boolean))]
const metricYear = Number(arg('metric-year')) || years[0]
if (years.length > 1 && !arg('metric-year')) {
  console.error(`PCS inputs mix metric years ${years.join(', ')}; pass --metric-year.`)
  process.exit(1)
}

// PSC classification per journal.
const psc = new Map()
for (const p of corpusPaths) {
  for (const j of readJson(p)) {
    const id = j.posi_id ?? j.journal_id ?? j.id
    if (!id) continue
    psc.set(id, {
      psc_category: j.psc_category ?? j.citation_preview?.psc_category ?? j.s ?? null,
      psc_confidence: j.psc_confidence ?? j.citation_preview?.psc_confidence ?? j.sc ?? null,
    })
  }
}

const entries = [...pcsById.values()]
  .filter(r => r.metric_year === metricYear)
  .map(r => ({
    journal_id: r.journal_id,
    pcs: r.pcs,
    pcs_eligible_items: r.pcs_eligible_items,
    pcs_coverage: r.pcs_coverage,
    psc_category: psc.get(r.journal_id)?.psc_category ?? null,
    psc_confidence: psc.get(r.journal_id)?.psc_confidence ?? null,
  }))
  .sort((a, b) => a.journal_id.localeCompare(b.journal_id))

const records = rankPcsTrack(entries, { metric_year: metricYear })

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const edition = {
  methodology_version: PCS_Q_METHODOLOGY_VERSION,
  metric_year: metricYear,
  generated_at: new Date().toISOString(),
  parameters: { min_items: PCS_Q_MIN_ITEMS, min_coverage: PCS_Q_MIN_COVERAGE, min_category_size: MIN_CATEGORY_SIZE, rank_eligible_psc_confidence: ['high', 'verified'] },
  inputs: [
    ...[...pcsPaths, ...corpusPaths].map(p => ({ file: basename(p), sha256: sha(p) })),
    ...pcsDirs.map(d => ({ dir: basename(d), files: shardFiles(d).length, sha256: createHash('sha256').update(shardFiles(d).sort().map(f => sha(f)).join('')).digest('hex') })),
  ],
  records,
}
writeFileSync(join(outDir, `pcs-q-${metricYear}.json`), JSON.stringify(edition) + '\n')

const cols = ['journal_id', 'category_code', 'pcs', 'pcs_eligible_items', 'rank', 'rank_mid', 'category_size', 'percentile', 'quartile_label', 'overall_rank', 'overall_size', 'overall_percentile', 'ranking_method', 'exclusion_reason']
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
writeFileSync(join(outDir, `pcs-q-${metricYear}.csv`), [cols.join(','), ...records.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n')

const count = f => records.filter(f).length
const byReason = {}
for (const r of records) if (r.exclusion_reason) byReason[r.exclusion_reason] = (byReason[r.exclusion_reason] ?? 0) + 1
const categories = {}
for (const r of records) if (r.rank != null) categories[r.category_code] = r.category_size
const summary = {
  methodology_version: PCS_Q_METHODOLOGY_VERSION,
  metric_year: metricYear,
  journals_in: records.length,
  overall_ranked: count(r => r.overall_rank != null),
  category_ranked: count(r => r.rank != null),
  by_quartile: Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4'].map(q => [q, count(r => r.quartile === q)])),
  not_category_ranked_by_reason: byReason,
  ranked_categories: Object.keys(categories).length,
  category_sizes: Object.fromEntries(Object.entries(categories).sort()),
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, category_sizes: undefined }, null, 2))
