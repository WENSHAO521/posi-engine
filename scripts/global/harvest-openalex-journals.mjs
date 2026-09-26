#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.1 — harvest every OpenAlex source of type journal,
 * classified into PSC with the corpus classifier.
 *
 *   node scripts/global/harvest-openalex-journals.mjs --out <dir>/openalex-journals.jsonl [--limit N] [--filter works_count:<20]
 *
 * --filter adds an OpenAlex filter so the list can be harvested as parallel
 * partitions (e.g. by works_count range); the corpus builder merges the parts.
 *
 * Resumable: re-running continues from the saved cursor.
 */
import { arg, harvestCursor, MAILTO } from './lib.mjs'
import { fromOpenAlexSource } from '../../src/global-index.mjs'

const out = arg('out')
if (!out) { console.error('Usage: --out <file.jsonl> [--limit N]'); process.exit(1) }
const limit = Number(arg('limit')) || Infinity
const extra = arg('filter')
const filter = ['type:journal', extra].filter(Boolean).join(',')
const select = 'id,display_name,host_organization_name,issn_l,issn,country_code,is_oa,is_in_doaj,apc_usd,works_count,topics'

await harvestCursor({
  label: `OpenAlex journals${extra ? ` (${extra})` : ''}`,
  out,
  limit,
  firstUrl: cursor => `https://api.openalex.org/sources?filter=${filter}&per-page=200&cursor=${encodeURIComponent(cursor)}&select=${select}&mailto=${MAILTO}`,
  pick: j => ({ items: j.results ?? [], next: j.meta?.next_cursor ?? null, total: j.meta?.count }),
  map: fromOpenAlexSource,
})
