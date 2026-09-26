#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.1 — harvest every OpenAlex source of type journal,
 * classified into PSC with the corpus classifier.
 *
 *   node scripts/global/harvest-openalex-journals.mjs --out <dir>/openalex-journals.jsonl [--limit N]
 *
 * Resumable: re-running continues from the saved cursor.
 */
import { arg, harvestCursor, MAILTO } from './lib.mjs'
import { fromOpenAlexSource } from '../../src/global-index.mjs'

const out = arg('out')
if (!out) { console.error('Usage: --out <file.jsonl> [--limit N]'); process.exit(1) }
const limit = Number(arg('limit')) || Infinity
const select = 'id,display_name,host_organization_name,issn_l,issn,country_code,is_oa,is_in_doaj,apc_usd,works_count,topics'

await harvestCursor({
  label: 'OpenAlex journals',
  out,
  limit,
  firstUrl: cursor => `https://api.openalex.org/sources?filter=type:journal&per-page=200&cursor=${encodeURIComponent(cursor)}&select=${select}&mailto=${MAILTO}`,
  pick: j => ({ items: j.results ?? [], next: j.meta?.next_cursor ?? null, total: j.meta?.count }),
  map: fromOpenAlexSource,
})
