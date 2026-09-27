#!/usr/bin/env node
/**
 * Rewrites <pcs-dir>/summary.json from every per-journal result in
 * <pcs-dir>/journals, with the same fields run-pcs-etl.mjs writes. Used after
 * parallel shards are merged, since each shard's own summary covers only
 * the journals it processed.
 *
 *   node scripts/global/summarize-pcs.mjs --pcs-dir work/pcs
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arg } from './lib.mjs'

const dir = arg('pcs-dir', 'work/pcs')
const results = readdirSync(join(dir, 'journals')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, 'journals', f), 'utf-8')))
const first = results[0] ?? {}
const withCoverage = results.filter(r => r.pcs_coverage != null)
const summary = {
  metric_year: first.metric_year ?? null,
  pcs_window_start_year: first.pcs_window_start_year ?? null,
  pcs_window_end_year: first.pcs_window_end_year ?? null,
  input_journals: results.length,
  journals_with_issn: results.filter(r => r.issn_queried).length,
  journals_with_no_issn: results.filter(r => !r.issn_queried).length,
  journals_with_crossref_404: results.filter(r => r.fetch_status === 404).length,
  journals_with_complete_fetch: results.filter(r => r.fetch_status === 200 && r.pcs_coverage === 1).length,
  journals_with_partial_fetch: results.filter(r => r.fetch_status === 200 && r.pcs_coverage != null && r.pcs_coverage < 1).length,
  journals_with_zero_eligible_items: results.filter(r => r.pcs_eligible_items === 0).length,
  journals_with_pcs_computed: results.filter(r => r.pcs != null).length,
  total_works_fetched: results.reduce((s, r) => s + (r.works_fetched ?? 0), 0),
  total_eligible_items: results.reduce((s, r) => s + (r.pcs_eligible_items ?? 0), 0),
  total_citation_count: results.reduce((s, r) => s + (r.pcs_citation_count ?? 0), 0),
  mean_pcs_coverage: withCoverage.length ? withCoverage.reduce((s, r) => s + r.pcs_coverage, 0) / withCoverage.length : null,
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
