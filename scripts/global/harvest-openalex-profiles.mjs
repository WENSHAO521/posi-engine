#!/usr/bin/env node
/**
 * Daily refresh of the journal profiles (works, citations, h-index, i10-index, works and citations per
 * year, topics) from the OpenAlex API, with the project's OPENALEX_API_KEY. The monthly directory
 * refresh takes them from the OpenAlex snapshot, which OpenAlex publishes about once a month, so
 * without this a journal page could show figures up to two months old.
 *
 *   OPENALEX_API_KEY=... node scripts/global/harvest-openalex-profiles.mjs --out <dir>/openalex-profiles.jsonl
 *
 * Every journal source, 200 per request with a cursor: about 1,300 list requests, roughly USD 0.13 of
 * the key's daily budget. Output lines match harvest-openalex-snapshot.mjs --profiles. Resumable: the
 * cursor is saved next to the output (<out>.state.json).
 */
import { rmSync } from 'fs'
import { arg, flag, harvestCursor, MAILTO } from './lib.mjs'
import { profileOf } from './profile.mjs'

/** Exactly the source fields profileOf() reads. */
export const PROFILE_SELECT = [
  'id', 'display_name', 'abbreviated_title', 'alternate_titles', 'homepage_url', 'apc_usd', 'country_code',
  'host_organization_name', 'works_count', 'cited_by_count', 'summary_stats', 'first_publication_year',
  'last_publication_year', 'counts_by_year', 'topics', 'societies',
].join(',')

export function pageUrl(cursor) {
  const sp = new URLSearchParams({ filter: 'type:journal', 'per-page': '200', cursor, select: PROFILE_SELECT, mailto: MAILTO })
  return `https://api.openalex.org/sources?${sp}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = arg('out')
  if (!out) { console.error('Usage: --out <file.jsonl> [--fresh] [--limit N]'); process.exit(1) }
  if (flag('fresh')) { rmSync(out, { force: true }); rmSync(`${out}.state.json`, { force: true }) }
  const limit = Number(arg('limit')) || Infinity
  const state = await harvestCursor({
    out, limit, label: 'OpenAlex journal profiles',
    firstUrl: pageUrl,
    pick: j => ({ items: j.results ?? [], next: j.meta?.next_cursor ?? null, total: j.meta?.count }),
    map: profileOf,
  })
  if (!state.done) { console.error(`Stopped at ${state.written} profiles; re-run to resume.`); process.exit(1) }
  console.log(`Wrote ${state.written} journal profiles to ${out}`)
}
