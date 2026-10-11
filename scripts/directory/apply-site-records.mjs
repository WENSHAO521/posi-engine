#!/usr/bin/env node
/**
 * apply-site-records.mjs
 *
 * Takes the changes the directory scripts made to the exported site records and writes them back to a
 * posi-data checkout, where the data lives:
 *
 *   - screening fields (scores, DOAJ status, subjects, article count ...) of a journal that was already
 *     there: replaced in screening/discovered-screening.jsonl;
 *   - descriptive fields of a journal that was already there (country, publisher, website, open access,
 *     OpenAlex id): filled in journals/discovered/*.jsonl only where the record has nothing, never
 *     overwritten; title, ISSNs and anything on a journals/core record are never changed, and a different
 *     value found for them is listed in proposed-changes.csv for a person;
 *   - a journal that was not there: minted through posi-data's scripts/ingest-crossref-publisher.mjs (the
 *     registry decides whether it is new; a journal with the title of an existing one and no ISSN in common is held for
 *     review, not minted) and given a screening record.
 *
 * Nothing is deleted. Writes nothing when nothing changed. A summary goes to --report-dir.
 *
 *   node scripts/directory/apply-site-records.mjs --data posi-data --baseline work/baseline.json \
 *     --records work/discovered-journals.json --report-dir work/apply-report [--today 2026-10-11]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { isoToCountry } from './lib/country-codes.mjs'

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SCREEN_FIELDS = ['language', 'frequency', 'license', 'peer_review_type', 'oai_base_url', 'registration_country', 'doaj_status',
  'metadata_quality_score', 'transparency_score', 'indexing_readiness', 'pqf', 'article_count', 'auto_pqf', 'subjects', 'crossref_checked_at', 'created_at', 'updated_at']
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const empty = (v) => v === null || v === undefined || v === ''

const nameToIso = new Map()
const validIso = new Set()
for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const n = isoToCountry(a + b); if (n && n !== a + b) { nameToIso.set(n, a + b); validIso.add(a + b) } }

export async function applyRecords({ data, baseline, records, reportDir, today = new Date().toISOString().slice(0, 10), engine = ENGINE }) {
  data = resolve(data)
  const { loadJournalRecords } = await import(pathToFileURL(join(data, 'scripts/lib/journal-records.mjs')).href)
  const screenFile = join(data, 'screening/discovered-screening.jsonl')
  const screening = readFileSync(screenFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const byCode = new Map(screening.map((s) => [s.journal_code, s]))
  const base = new Map(baseline.map((r) => [r.id, r]))
  const summary = { screening_updated: 0, filled: 0, proposed: 0, new_candidates: 0, minted: 0, new_screening: 0, held_for_review: 0, unchanged: 0 }
  const proposed = [], fills = new Map(), newOnes = []
  const now = `${today}T00:00:00.000Z`

  for (const r of records) {
    const b = base.get(r.id)
    if (!b) { newOnes.push(r); continue }
    const s = byCode.get(r.journal_code)
    if (!s) continue
    let touched = false
    for (const f of SCREEN_FIELDS) if (!same(r[f], b[f]) && !same(r[f], s[f])) { s[f] = r[f] ?? null; touched = true }
    if (touched) summary.screening_updated++
    const fill = {}
    // Empty, or not a country at all (the record holds a MARC or other non-ISO code such as "TU", exported as is):
    // the country the scripts worked out replaces it, as an ISO code.
    if (!same(r.country, b.country) && (empty(b.country) || !nameToIso.has(b.country)) && nameToIso.get(r.country)) fill.country = nameToIso.get(r.country)
    if (!same(r.publisher, b.publisher) && empty(b.publisher) && r.publisher) fill.publisher = r.publisher
    if (!same(r.website_url, b.website_url) && empty(b.website_url) && r.website_url) fill.website_url = r.website_url
    if (!same(r.open_access, b.open_access) && b.open_access == null && typeof r.open_access === 'boolean') fill.open_access = r.open_access
    if (!same(r.openalex_source_id, b.openalex_source_id) && empty(b.openalex_source_id) && r.openalex_source_id) fill.openalex_source_id = r.openalex_source_id
    if (Object.keys(fill).length) fills.set(s.posi_id, { fill, site_id: r.id })
    for (const f of ['title', 'issn_print', 'issn_online', 'short_title', 'publisher', 'country', 'website_url', 'open_access', 'openalex_source_id']) {
      if (!same(r[f], b[f]) && !(f in fill)) proposed.push({ journal_code: r.journal_code, field: f, before: b[f] ?? '', after: r[f] ?? '' })
    }
  }

  // Fill empty descriptive fields of discovered records.
  if (fills.size) {
    const dir = join(data, 'journals/discovered')
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      let changed = false
      const out = readFileSync(join(dir, f), 'utf8').split('\n').map((line) => {
        if (!line.trim()) return line
        const j = JSON.parse(line)
        const x = fills.get(j.id); if (!x) return line
        let t = false
        for (const [k, v] of Object.entries(x.fill)) {
          if (k === 'openalex_source_id') { if (empty(j.identifiers.openalex_source_id)) { j.identifiers.openalex_source_id = v; t = true } }
          else if (k === 'country') { if (empty(j.country) || !validIso.has(j.country)) { j.country = v; t = true } }
          else if (empty(j[k]) && (k !== 'open_access' || j[k] == null)) { j[k] = v; t = true }
        }
        if (!t) return line
        j.provenance.push({ source: 'posi_curation', source_record_id: x.site_id, retrieved_at: now, license: null })
        j.updated_at = now; summary.filled++; changed = true
        return JSON.stringify(j)
      })
      if (changed) writeFileSync(join(dir, f), out.join('\n'), 'utf8')
    }
  }

  // New journals: through the registry.
  if (newOnes.length) {
    const cand = newOnes.filter((r) => r.issn_print || r.issn_online).map((r) => {
      const t = []
      if (r.issn_online) t.push({ value: r.issn_online, type: 'electronic' })
      if (r.issn_print) t.push({ value: r.issn_print, type: 'print' })
      const listed = r.doaj_status === 'listed'
      return { title: r.title, publisher: r.publisher || undefined, ISSN: t.map((x) => x.value), 'issn-type': t, doaj: listed ? true : undefined,
        website_url: r.website_url || undefined, openalex_source_id: r.openalex_source_id || undefined,
        provenance: [{ source: listed ? 'doaj' : 'openalex', source_record_id: listed ? null : r.openalex_source_id ?? null }, { source: 'posi_curation', source_record_id: r.id }] }
    })
    summary.new_candidates = cand.length
    if (cand.length) {
      const dir = join(data, 'audits/migrations', `directory-sync-${today}`)
      mkdirSync(dir, { recursive: true })
      const candFile = join(dir, 'candidates.json')
      writeFileSync(candFile, JSON.stringify(cand))
      const out = execFileSync('node', [join(data, 'scripts/ingest-crossref-publisher.mjs'), '--data', data, '--engine', engine, '--candidates', candFile,
        '--member', 'directory-sync', '--retrieved', today, '--out', `directory-sync-${today}`, '--audit-dir', dir], { encoding: 'utf8' })
      const res = JSON.parse(out.trim().split('\n').pop())
      summary.minted = res.ids_minted; summary.held_for_review = res.held_for_review
      // Screening records for every new site record that now has a POSI journal (by ISSN).
      const journals = loadJournalRecords(data)
      const byIssn = new Map()
      for (const j of journals.values()) for (const i of [j.identifiers?.issn_l, j.identifiers?.issn_print, j.identifiers?.issn_online]) if (i && !byIssn.has(i)) byIssn.set(i, j.id)
      const taken = new Set(screening.map((s) => s.posi_id))
      for (const r of newOnes) {
        const id = [r.issn_online, r.issn_print].map((i) => byIssn.get(i)).find(Boolean)
        if (!id || taken.has(id)) continue
        taken.add(id)
        const s = { posi_id: id, journal_code: r.journal_code }
        for (const f of SCREEN_FIELDS) s[f] = r[f] ?? null
        screening.push(s); byCode.set(s.journal_code, s); summary.new_screening++
      }
    }
  }

  if (summary.screening_updated || summary.new_screening) {
    screening.sort((a, b) => (a.posi_id < b.posi_id ? -1 : 1))
    writeFileSync(screenFile, screening.map((s) => JSON.stringify(s)).join('\n') + '\n')
  }
  summary.proposed = proposed.length
  summary.unchanged = records.length - summary.screening_updated - summary.new_candidates
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    writeFileSync(join(reportDir, 'proposed-changes.csv'), 'journal_code,field,before,after\n' + proposed.map((p) => [p.journal_code, p.field, JSON.stringify(p.before), JSON.stringify(p.after)].join(',')).join('\n') + '\n')
  }
  return summary
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
  if (!arg('data') || !arg('baseline') || !arg('records')) { console.error('usage: --data <posi-data> --baseline <file> --records <file> [--report-dir <dir>] [--today YYYY-MM-DD]'); process.exit(2) }
  const summary = await applyRecords({ data: arg('data'), baseline: JSON.parse(readFileSync(arg('baseline'), 'utf8')), records: JSON.parse(readFileSync(arg('records'), 'utf8')),
    reportDir: arg('report-dir'), ...(arg('today') ? { today: arg('today') } : {}) })
  console.log(JSON.stringify(summary))
}
