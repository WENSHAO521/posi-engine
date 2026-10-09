#!/usr/bin/env node
/**
 * run-output-history-etl.mjs — Output-History ETL: works per publication
 * year for every journal in a corpus, from its OpenAlex source record
 * (src/output-history.mjs). Feeds AJR-M Dimension 2 (five-year continuity,
 * output stability) through posi-data's evidence/output/, so scoring
 * (scripts/rate-mature.mjs) reads stored evidence and never a live source.
 *
 * Writes <out>/journals/<posi_id>.json:
 *   { posi_id, title, openalex_source_id, counts_by_year: { "<year>": n } | null,
 *     fetch_error: string | null, snapshot_date }
 * counts_by_year is null when the source could not be read, never an empty
 * history standing in for a failed request. Plus <out>/summary.json.
 *
 * Usage:
 *   node scripts/run-output-history-etl.mjs --corpus <corpus JSON> --out <dir> \
 *     [--mature-only] [--limit N] [--delay-ms 120]
 *
 * --mature-only fetches only journals that are Mature (LIFECYCLE-1.1) on the
 * snapshot date, the only ones AJR-M reads.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { fetchCountsByYear } from '../src/output-history.mjs'
import { classifyLifecycle } from '../src/lifecycle.mjs'
import { withoutWithdrawn } from '../src/withdrawn.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

async function main() {
  if (!arg('corpus') || !arg('out')) {
    console.error('Usage: node scripts/run-output-history-etl.mjs --corpus <corpus JSON> --out <dir> [--mature-only] [--limit N] [--delay-ms 120]')
    process.exit(1)
  }
  const corpusRaw = JSON.parse(readFileSync(resolve(arg('corpus')), 'utf-8'))
  const corpus = withoutWithdrawn(Array.isArray(corpusRaw) ? corpusRaw : (corpusRaw.journals ?? []))
  const snapshotDate = new Date().toISOString().slice(0, 10)
  const asOf = new Date(`${snapshotDate}T00:00:00Z`)
  const delayMs = Number(arg('delay-ms', '120'))
  const limit = arg('limit') ? Number(arg('limit')) : null
  let targets = process.argv.includes('--mature-only')
    ? corpus.filter(j => classifyLifecycle(j.early_stage_rating?.first_published ?? null, asOf).lifecycle_stage === 'mature')
    : corpus
  if (limit) targets = targets.slice(0, limit)

  const journalsDir = join(resolve(arg('out')), 'journals')
  mkdirSync(journalsDir, { recursive: true })
  console.log(`${targets.length} of ${corpus.length} journals to fetch`)

  let ok = 0
  for (const [i, j] of targets.entries()) {
    const r = await fetchCountsByYear(j.openalex_source_id)
    if (r.counts_by_year) ok++
    const record = { posi_id: j.posi_id, title: j.title, openalex_source_id: j.openalex_source_id ?? null, counts_by_year: r.counts_by_year, fetch_error: r.error, snapshot_date: snapshotDate }
    writeFileSync(join(journalsDir, `${j.posi_id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf-8')
    console.log(`[${i + 1}/${targets.length}] ${j.posi_id} ${r.counts_by_year ? `${Object.keys(r.counts_by_year).length} years` : `no history (${r.error})`}`)
    if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs))
  }

  const summary = { input_journals: targets.length, with_history: ok, without_history: targets.length - ok, snapshot_date: snapshotDate }
  writeFileSync(join(resolve(arg('out')), 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
