#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.2 — harvest every journal registered with Crossref.
 *
 *   node scripts/global/harvest-crossref-journals.mjs --out <dir>/crossref-journals.jsonl [--limit N]
 *
 * Resumable: re-running continues from the saved cursor.
 */
import { arg, harvestCursor, MAILTO } from './lib.mjs'
import { fromCrossrefJournal } from '../../src/global-index.mjs'

const out = arg('out')
if (!out) { console.error('Usage: --out <file.jsonl> [--limit N]'); process.exit(1) }
const limit = Number(arg('limit')) || Infinity

await harvestCursor({
  label: 'Crossref journals',
  out,
  limit,
  firstUrl: cursor => `https://api.crossref.org/journals?rows=1000&cursor=${encodeURIComponent(cursor)}&mailto=${MAILTO}`,
  pick: j => ({ items: j.message?.items ?? [], next: j.message?.['next-cursor'] ?? null, total: j.message?.['total-results'] }),
  map: fromCrossrefJournal,
})
