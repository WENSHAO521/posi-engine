#!/usr/bin/env node
/**
 * run-citation-ranking.mjs — builds the POSI Citation Ranking edition
 * (posi-data/POSI-EVAL-1.0-SPEC.md, CITATION-RANK-1.0): PNCI-1.0 for every
 * journal, then rank, percentile, Citation Quartile and POSI Zone within
 * each PSC category.
 *
 * Inputs
 *   --pcs-dir <dir>     a run-pcs-etl.mjs output directory: <dir>/journals/<id>.json
 *                       (per-journal results; `cells` carry the per-item citation
 *                       histograms PNCI needs). Repeatable.
 *   --corpus <file>     corpus JSON arrays with posi_id + psc_category + psc_confidence
 *                       (+ early_stage_rating for the lifecycle stage). Repeatable.
 *   [--pci <file>]      PCI records (collections/pci.json), carried as a descriptive field.
 *   [--taxonomy <file>] PSC taxonomy (posi-data taxonomy/psc/v1.0.json) for category names.
 *   --out <dir>
 *   [--snapshot-date YYYY-MM-DD]  defaults to today (UTC)
 *   [--metric-year Y]            defaults to the metric_year in the PCS results
 *
 * Outputs (in --out)
 *   citation-ranking-<Y>.json   { evaluation_version, …, snapshot_date, parameters, inputs, records }
 *   citation-ranking-<Y>.csv
 *   summary.json                counts by status, quartile, zone; category sizes
 *
 * A journal whose PCS result predates PNCI-1.0 (no `cells`) gets pnci: null
 * and status not_available until run-pcs-etl.mjs --require-cells fetches it
 * again; the edition never falls back to PCS for ranking.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, join, basename } from 'path'
import { createHash } from 'crypto'
import { buildBaselines, calculatePNCI, PNCI_MODEL_VERSION, MIN_BASELINE_ITEMS } from '../src/pnci.mjs'
import { rankCitationEdition } from '../src/citation-ranking.mjs'
import {
  EVALUATION_VERSION, CITATION_RANK_VERSION, ZONES_VERSION, RANKING_THRESHOLDS, getLifecycleStage,
} from '../src/evaluation.mjs'

const all = name => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) o.push(process.argv[i + 1]); return o.filter(Boolean) }
const arg = (name, fallback = null) => all(name)[0] ?? fallback

const pcsDirs = all('pcs-dir')
const corpusPaths = all('corpus')
const outDir = arg('out')
if (!pcsDirs.length || !outDir) {
  console.error('Usage: node scripts/run-citation-ranking.mjs --pcs-dir <etl out> [--pcs-dir …] --corpus <corpus.json> [--corpus …] [--pci pci.json] [--taxonomy v1.0.json] --out <dir> [--snapshot-date YYYY-MM-DD]')
  process.exit(1)
}
const snapshotDate = arg('snapshot-date', new Date().toISOString().slice(0, 10))
const readJson = p => { const raw = JSON.parse(readFileSync(resolve(p), 'utf-8')); return Array.isArray(raw) ? raw : raw.records ?? raw.journals ?? raw.categories ?? [] }
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex')

// Classification, identity and lifecycle per journal.
const meta = new Map()
for (const p of corpusPaths) {
  for (const j of readJson(p)) {
    const id = j.posi_id ?? j.journal_id ?? j.id
    if (!id) continue
    const r = j.early_stage_rating
    const stage = r ? (r.lifecycle_stage ?? (['observation', 'early_stage', 'mature'].includes(r.eligibility) ? r.eligibility : getLifecycleStage(r.months_since_launch))) : null
    meta.set(id, {
      psc_category: j.psc_category ?? j.citation_preview?.psc_category ?? j.s ?? null,
      psc_confidence: j.psc_confidence ?? j.citation_preview?.psc_confidence ?? j.sc ?? null,
      lifecycle_stage: stage && stage !== 'unknown' ? stage : null,
      title: j.title ?? j.t ?? null,
      publisher: j.publisher ?? j.p ?? null,
      issn: [...new Set([...(j.issns ?? []), j.issn_online, j.issn_print, ...(j.i ?? [])].filter(Boolean))],
      open_access: j.open_access ?? null,
    })
  }
}
const pci = new Map((arg('pci') ? readJson(arg('pci')) : []).map(r => [r.journal_id, r.pci ?? null]))
const categoryNames = Object.fromEntries((arg('taxonomy') ? readJson(arg('taxonomy')) : []).map(c => [c.code, c.name]))

// Per-journal PCS results (with cells).
const journals = []
for (const dir of pcsDirs) {
  const jdir = existsSync(join(dir, 'journals')) ? join(dir, 'journals') : dir
  for (const f of readdirSync(jdir)) {
    if (!f.endsWith('.json')) continue
    const r = JSON.parse(readFileSync(join(jdir, f), 'utf-8'))
    const id = r.posi_id ?? r.journal_id
    if (!id) continue
    const m = meta.get(id) ?? {}
    const field = m.psc_confidence === 'multidisciplinary' ? null : (m.psc_category ?? null)
    journals.push({
      journal_id: id, field, cells: r.cells ?? null, metric_year: r.metric_year,
      coverage: r.pcs_coverage ?? null, pcs: r.pcs ?? null, pcs_methodology_version: r.pcs_methodology_version ?? null,
      eligible_items: r.pcs_eligible_items ?? 0,
    })
  }
}
const years = [...new Set(journals.map(j => j.metric_year).filter(Boolean))]
const metricYear = Number(arg('metric-year')) || years[0]
if (years.length > 1 && !arg('metric-year')) { console.error(`PCS results mix metric years ${years.join(', ')}; pass --metric-year.`); process.exit(1) }

// Baselines from journals whose citation data is complete enough to rank.
const baselines = buildBaselines(journals.filter(j => j.field && j.cells && j.coverage != null && j.coverage >= RANKING_THRESHOLDS.minCoverage))

const entries = journals
  .filter(j => j.metric_year === metricYear)
  .sort((a, b) => a.journal_id.localeCompare(b.journal_id))
  .map(j => {
    const m = meta.get(j.journal_id) ?? {}
    const p = j.cells ? calculatePNCI(j, baselines) : null
    return {
      journal_id: j.journal_id,
      pnci: p?.pnci ?? null,
      pnci_model_version: p ? PNCI_MODEL_VERSION : null,
      normalization: p?.normalization ?? null,
      eligible_items: p ? p.eligible_items : j.eligible_items,
      publication_years: p?.publication_years ?? [],
      coverage: j.coverage,
      median_normalized_citation: p?.median_normalized_citation ?? null,
      top10_share: p?.top10_share ?? null,
      total_citations: p?.total_citations ?? null,
      pcs: j.pcs, pcs_methodology_version: j.pcs_methodology_version, pci: pci.get(j.journal_id) ?? null,
      psc_category: m.psc_category ?? null, psc_confidence: m.psc_confidence ?? null, lifecycle_stage: m.lifecycle_stage ?? null,
    }
  })

const records = rankCitationEdition(entries, { metric_year: metricYear, snapshot_date: snapshotDate, categoryNames })
  .map(r => { const m = meta.get(r.journal_id) ?? {}; return { ...r, title: m.title ?? null, publisher: m.publisher ?? null, issn: m.issn ?? [], open_access: m.open_access ?? null } })

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const edition = {
  evaluation_version: EVALUATION_VERSION,
  ranking_methodology_version: CITATION_RANK_VERSION,
  pnci_model_version: PNCI_MODEL_VERSION,
  zones_version: ZONES_VERSION,
  metric_year: metricYear,
  snapshot_date: snapshotDate,
  generated_at: new Date().toISOString(),
  parameters: {
    ...RANKING_THRESHOLDS,
    min_baseline_items: MIN_BASELINE_ITEMS,
    rank_eligible_psc_confidence: ['high', 'verified'],
    ranking_metric: 'pnci',
    tie_rule: 'shared competition rank, mid-rank percentile',
  },
  inputs: [
    ...corpusPaths.map(p => ({ file: basename(p), sha256: sha(p) })),
    ...(arg('pci') ? [{ file: basename(arg('pci')), sha256: sha(arg('pci')) }] : []),
    ...pcsDirs.map(d => ({ dir: basename(d), journals: journals.length })),
  ],
  records,
}
writeFileSync(join(outDir, `citation-ranking-${metricYear}.json`), JSON.stringify(edition) + '\n')

const cols = ['journal_id', 'title', 'publisher', 'ranking_category_id', 'pnci', 'eligible_citable_items', 'citation_coverage', 'citation_rank', 'citation_rank_total', 'citation_percentile', 'citation_quartile', 'posi_zone', 'zone_status', 'citation_ranking_status', 'ranking_status_reason', 'pcs', 'pci', 'ranking_snapshot_date']
const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
writeFileSync(join(outDir, `citation-ranking-${metricYear}.csv`), [cols.join(','), ...records.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n')

const count = f => records.filter(f).length
const by = key => { const o = {}; for (const r of records) { const k = r[key] ?? 'none'; o[k] = (o[k] ?? 0) + 1 } return o }
const categories = {}
for (const r of records) if (r.citation_rank_total) categories[r.ranking_category_id] = r.citation_rank_total
const summary = {
  evaluation_version: EVALUATION_VERSION, ranking_methodology_version: CITATION_RANK_VERSION, pnci_model_version: PNCI_MODEL_VERSION,
  metric_year: metricYear, snapshot_date: snapshotDate,
  journals_in: records.length,
  with_pnci: count(r => r.pnci != null),
  without_cells: journals.filter(j => !j.cells && j.eligible_items > 0).length,
  ranked: count(r => r.citation_rank != null),
  by_status: by('citation_ranking_status'),
  by_quartile: by('citation_quartile'),
  by_zone: by('posi_zone'),
  ranked_categories: Object.keys(categories).length,
  category_sizes: Object.fromEntries(Object.entries(categories).sort()),
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ...summary, category_sizes: undefined }, null, 2))
