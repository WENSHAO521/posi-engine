#!/usr/bin/env node
/**
 * export-site-records.mjs
 *
 * Composes the discovered journals of a posi-data checkout (journal records joined to screening/discovered-screening.jsonl)
 * into the site-shaped records the scripts in this directory work on, one array in a JSON file written
 * one record per line. Run before them in the directory-sync workflow; the output is also the baseline
 * apply-site-records.mjs compares their result with.
 *
 *   node scripts/directory/export-site-records.mjs --data posi-data --out work/discovered-journals.json
 */
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { pathToFileURL } from 'url'
import { isoToCountry } from './lib/country-codes.mjs'

export function toSiteRecord(d) {
  return {
    id: `j-disc-${d.journal_code}`, journal_code: d.journal_code,
    title: d.title, short_title: d.short_title ?? d.title,
    issn_print: d.issn_print, issn_online: d.issn_online,
    publisher: d.publisher ?? '', country: d.country ? isoToCountry(d.country) : '',
    language: d.language ?? 'English', frequency: d.frequency ?? '',
    open_access: d.open_access, license: d.license, peer_review_type: d.peer_review_type,
    website_url: d.website_url ?? '', oai_base_url: d.oai_base_url, registration_country: d.registration_country, doaj_status: d.doaj_status,
    openalex_source_id: d.openalex_source_id ? String(d.openalex_source_id).replace(/^https?:\/\/openalex\.org\//, '') : null,
    metadata_quality_score: d.metadata_quality_score, transparency_score: d.transparency_score, indexing_readiness: d.indexing_readiness,
    pqf: d.pqf, article_count: d.article_count, auto_pqf: d.auto_pqf,
    created_at: d.created_at, updated_at: d.updated_at, subjects: d.subjects, crossref_checked_at: d.crossref_checked_at,
  }
}

export async function exportSiteRecords(dataDir) {
  const { composeDiscovered } = await import(pathToFileURL(join(resolve(dataDir), 'scripts/lib/compose-discovered.mjs')).href)
  return composeDiscovered(resolve(dataDir)).map(toSiteRecord)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
  const data = arg('data'), out = arg('out')
  if (!data || !out) { console.error('usage: --data <posi-data> --out <file>'); process.exit(2) }
  const records = await exportSiteRecords(data)
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, '[\n' + records.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n')
  console.log(`export-site-records: ${records.length} records -> ${out}`)
}
