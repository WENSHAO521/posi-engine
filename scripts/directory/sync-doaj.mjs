#!/usr/bin/env node
/**
 * sync-doaj.mjs
 *
 * Brings the Discovered journals in line with DOAJ's full journal list.
 * Runs twice a month from .github/workflows/doaj-sync.yml.
 *
 * Source: DOAJ's journal CSV (https://doaj.org/docs/journal-csv/), one row per
 * journal currently in DOAJ. It is open to everyone and at most 30 days old;
 * with a premium API key (DOAJ_API_KEY) it is at most an hour old. The search
 * API cannot list the whole catalogue (it stops at 1,000 results per query),
 * the full data dump needs separate approval from DOAJ, and the daily OpenAlex
 * step only sees the first 100 sources.
 *
 * What it changes in src/lib/discovered-journals.json:
 *   1. Journals in DOAJ but not in the index are added as Discovered records.
 *   2. Records found in DOAJ (by ISSN) are marked listed, and their DOAJ fields
 *      are refreshed: license, language, subjects, homepage, review type.
 *      Missing ISSNs, publisher and country are filled; a filled value is
 *      never replaced, so Crossref and manual corrections stay.
 *   3. Records marked listed that DOAJ no longer has (no ISSN or title match)
 *      are marked not_listed.
 * Core Collection records are curated in posi-data and are not touched; their
 * ISSNs are only used to avoid adding duplicates.
 *
 * Safety: if the CSV holds fewer than MIN_DOAJ_JOURNALS journals, nothing is
 * written. If step 3 would delist more than MAX_DELIST_SHARE of the listed
 * records, step 3 is skipped (a matching problem, not a mass withdrawal).
 *
 * Usage:
 *   DOAJ_API_KEY=xxx node scripts/sync-doaj.mjs            # dry run, prints a summary
 *   DOAJ_API_KEY=xxx node scripts/sync-doaj.mjs --write
 *   node scripts/sync-doaj.mjs --csv path/to/journalcsv.csv [--write]
 */

import { execFileSync } from 'child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { loadDiscovered, saveDiscovered, knownIssns } from './lib/discovered-store.mjs'
import { buildFromDoaj, buildRecord, languageName, licenseLabel } from './lib/doaj-record.mjs'
import { isoToCountry, canonicalCountryName } from './lib/country-codes.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
// posi-data's corpus/core-collection.json (POSI_CORE_FILE), the journals a DOAJ sync must not duplicate.
const CORE_FILE = process.env.POSI_CORE_FILE ?? join(__dir, '../../posi-data/corpus/core-collection.json')
const UA = 'POSI/0.1 (mailto:posi@panoramagroup.org)'
const CSV_URL = 'https://doaj.org/csv'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const CSV_FILE = (() => { const i = args.indexOf('--csv'); return i !== -1 ? args[i + 1] : null })()
const DOAJ_KEY = process.env.DOAJ_API_KEY ?? ''

// DOAJ lists about 22,000 journals; a CSV far below that is truncated.
const MIN_DOAJ_JOURNALS = 15000
const MAX_DELIST_SHARE = 0.05

const TODAY = new Date().toISOString().slice(0, 10)

// ── Download and read the journal CSV ──────────────────────────────────────

async function fetchCsv(withKey) {
  // The key goes in the query string, so the URL is never logged.
  const url = withKey ? `${CSV_URL}?api_key=${encodeURIComponent(DOAJ_KEY)}` : CSV_URL
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from the DOAJ journal CSV${withKey ? ' (with API key)' : ''}`)
  return Buffer.from(await res.arrayBuffer())
}

async function downloadCsv() {
  for (let attempt = 1; ; attempt++) {
    try {
      if (DOAJ_KEY) {
        try { return await fetchCsv(true) } catch (e) {
          console.error(`  ⚠  ${e.message} — trying the public CSV`)
        }
      }
      return await fetchCsv(false)
    } catch (e) {
      if (attempt >= 3) throw e
      console.error(`  ⚠  ${e.message} — retrying in ${attempt * 30}s`)
      await new Promise(r => setTimeout(r, attempt * 30_000))
    }
  }
}

/** The CSV text, whether it came plain, gzipped or zipped. */
function csvText(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8')
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const dir = mkdtempSync(join(tmpdir(), 'doaj-'))
    try {
      writeFileSync(join(dir, 'doaj.zip'), buf)
      return execFileSync('unzip', ['-p', join(dir, 'doaj.zip')], { maxBuffer: 1 << 30 }).toString('utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return buf.toString('utf8')
}

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines. */
function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => v.trim()))
}

// Columns are found by name pattern, so a reworded header still matches.
const COLUMNS = {
  title:     [/^journal title$/i, /^title$/i],
  pissn:     [/issn.*print/i, /^pissn$/i],
  eissn:     [/eissn|online version/i],
  url:       [/^journal url$/i, /^journal homepage/i],
  publisher: [/^publisher$/i],
  country:   [/^country of publisher$/i],
  license:   [/^journal license$/i, /^license$/i],
  language:  [/^languages? in which/i, /^languages?$/i],
  subjects:  [/^subjects?$/i],
  review:    [/^review process$/i],
  weeks:     [/average number of weeks/i],
  seal:      [/doaj seal/i],
  apc:       [/^apc$/i, /^journal charges apc/i],
  apcAmount: [/^apc amount$/i],
  board:     [/editorial board/i],
}
const REQUIRED = ['title', 'pissn', 'eissn']

/** One DOAJ entry per CSV row, in the bibjson shape the API and buildFromDoaj use. */
function readCsv(text) {
  const [header, ...rows] = parseCsv(text)
  if (!header) throw new Error('The DOAJ journal CSV is empty')
  const col = {}
  for (const [key, patterns] of Object.entries(COLUMNS)) {
    const i = header.findIndex(h => patterns.some(p => p.test(h.trim())))
    if (i !== -1) col[key] = i
  }
  const lost = REQUIRED.filter(k => col[k] === undefined)
  if (lost.length) throw new Error(`DOAJ CSV columns not found: ${lost.join(', ')}. Header: ${header.join(' | ')}`)
  console.error(`  CSV columns: ${Object.entries(col).map(([k, i]) => `${k} ← "${header[i]}"`).join('; ')}`)
  const unmatched = Object.keys(COLUMNS).filter(k => col[k] === undefined)
  if (unmatched.length) console.error(`  ⚠  CSV columns not found (left out): ${unmatched.join(', ')}`)

  const list = v => (v ?? '').split(/\s*[,;|]\s*/).map(s => s.trim()).filter(Boolean)
  return rows.map((r, n) => {
    const get = key => (col[key] === undefined ? '' : (r[col[key]] ?? '').trim())
    const yes = v => /^(yes|true|y)$/i.test(v)
    // "Medicine: Internal medicine | Science: Chemistry" → the narrowest term of each
    const subjects = get('subjects').split('|').map(s => s.split(':').pop().trim()).filter(Boolean)
    const weeks = parseInt(get('weeks'), 10)
    return {
      id: `csv-${n}`,
      bibjson: {
        title: get('title'),
        pissn: get('pissn') || undefined,
        eissn: get('eissn') || undefined,
        ref: { journal: get('url') || undefined },
        publisher: { name: get('publisher') || undefined, country: canonicalCountryName(get('country')) || undefined },
        license: list(get('license')).slice(0, 1).map(type => ({ type })),
        language: list(get('language')),
        subject: subjects.map(term => ({ term })),
        editorial: { review_process: list(get('review')), board_url: get('board') || undefined },
        publication_time_weeks: Number.isFinite(weeks) ? weeks : undefined,
        apc: { has_apc: yes(get('apc')), max: get('apcAmount') ? [get('apcAmount')] : [] },
      },
      admin: { ticked: yes(get('seal')) },
    }
  }).filter(j => j.bibjson.title)
}

// ── Matching ────────────────────────────────────────────────────────────────

const normIssn = v => (typeof v === 'string' && /^\d{4}-?\d{3}[\dXx]$/.test(v.trim()))
  ? v.trim().toUpperCase().replace(/^(\d{4})-?/, '$1-') : null
const normTitle = t => (t ?? '').normalize('NFKD').toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, '')

function issnsOf(r) {
  return [normIssn(r.issn_online), normIssn(r.issn_print)].filter(Boolean)
}

// ── Refresh one record from its DOAJ entry ──────────────────────────────────

const isBlank = v => v == null || (typeof v === 'string' && v.trim() === '')
const sameList = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Returns the names of the fields it changed. */
function refresh(rec, item) {
  const bib = item.bibjson
  const changed = []
  const set = (field, value) => {
    if (value === undefined) return
    if (Array.isArray(value) ? sameList(rec[field], value) : rec[field] === value) return
    rec[field] = value
    changed.push(field)
  }

  set('doaj_status', 'listed')

  // Fields DOAJ is the source for: take its current value when it has one.
  const license = licenseLabel(bib)
  if (license) set('license', license)
  const lang = languageName(bib.language)
  if (lang) set('language', lang)
  const subjects = [...new Set((bib.subject ?? []).map(s => s.term).filter(Boolean))]
  if (subjects.length) set('subjects', subjects)
  const homepage = bib.ref?.journal
  if (typeof homepage === 'string' && homepage.trim()) set('website_url', homepage.trim())
  const review = [bib.editorial?.review_process ?? bib.editorial?.review_processes ?? []].flat()[0]
  if (review && (isBlank(rec.peer_review_type) || rec.peer_review_type === 'Peer review')) set('peer_review_type', review)

  // Fields other steps also fill: only fill gaps.
  if (isBlank(rec.issn_online) && normIssn(bib.eissn) && !issnsOf(rec).includes(normIssn(bib.eissn))) set('issn_online', normIssn(bib.eissn))
  if (isBlank(rec.issn_print) && normIssn(bib.pissn) && !issnsOf(rec).includes(normIssn(bib.pissn))) set('issn_print', normIssn(bib.pissn))
  if (isBlank(rec.publisher) && bib.publisher?.name) set('publisher', bib.publisher.name)
  const country = isoToCountry(bib.publisher?.country)
  if (isBlank(rec.country) && country) set('country', country)
  if (isBlank(rec.registration_country) && country) set('registration_country', country)

  if (changed.length) rec.updated_at = `${TODAY}T00:00:00Z`
  return changed
}

// ── Main ────────────────────────────────────────────────────────────────────

const summary = []
const log = line => { console.error(line); summary.push(line) }

let csv
if (CSV_FILE) {
  csv = readFileSync(CSV_FILE)
} else {
  console.error(`Downloading the DOAJ journal CSV (${DOAJ_KEY ? 'with' : 'without'} API key)...`)
  csv = await downloadCsv()
}
const doaj = readCsv(csvText(csv))

log(`DOAJ journal CSV: ${doaj.length} journals`)
if (doaj.length < MIN_DOAJ_JOURNALS) {
  console.error(`❌  Expected at least ${MIN_DOAJ_JOURNALS} journals; the CSV looks incomplete. Nothing written.`)
  process.exit(1)
}

// ISSN / title → DOAJ entry
const byIssn = new Map()
const byTitle = new Map()
for (const item of doaj) {
  for (const issn of [normIssn(item.bibjson.eissn), normIssn(item.bibjson.pissn)]) {
    if (issn && !byIssn.has(issn)) byIssn.set(issn, item)
  }
  const t = normTitle(item.bibjson.title)
  if (t) byTitle.set(t, byTitle.has(t) ? null : item)   // null = ambiguous title
}

const records = loadDiscovered()
const core = JSON.parse(readFileSync(CORE_FILE, 'utf8'))

// 1–2. Refresh the records DOAJ has; collect the listed ones it does not.
const matched = new Set()
let refreshed = 0
const fieldCounts = {}
const missing = []
for (const rec of records) {
  const item = issnsOf(rec).map(i => byIssn.get(i)).find(Boolean)
  if (item) {
    matched.add(item)
    const changed = refresh(rec, item)
    if (changed.length) refreshed++
    for (const f of changed) fieldCounts[f] = (fieldCounts[f] ?? 0) + 1
    continue
  }
  // Same journal under an ISSN DOAJ does not carry (e.g. an ISSN-L): still listed,
  // but not refreshed, since the match is weaker.
  const byName = byTitle.get(normTitle(rec.title))
  if (byName) { matched.add(byName); continue }
  if (rec.doaj_status === 'listed') missing.push(rec)
}
log(`Records refreshed from DOAJ: ${refreshed}` +
  (refreshed ? ` (${Object.entries(fieldCounts).map(([f, n]) => `${f} ${n}`).join(', ')})` : ''))

// 3. Delist the listed records DOAJ no longer has.
const listed = records.filter(r => r.doaj_status === 'listed').length + missing.length
if (missing.length > listed * MAX_DELIST_SHARE) {
  log(`⚠  ${missing.length} listed records are not in the CSV (more than ${MAX_DELIST_SHARE * 100}% of ${listed}); not delisting any. Check the matching.`)
} else {
  for (const rec of missing) {
    rec.doaj_status = 'not_listed'
    rec.updated_at = `${TODAY}T00:00:00Z`
  }
  log(`Records no longer in DOAJ, marked not_listed: ${missing.length}`)
  for (const r of missing.slice(0, 50)) log(`  - ${r.issn_online ?? r.issn_print ?? ''}  ${r.title}`)
}

// 4. Add the DOAJ journals the index does not have yet.
const known = knownIssns([...records, ...core].map(r => ({ issn_online: normIssn(r.issn_online), issn_print: normIssn(r.issn_print) })))
const knownTitles = new Set([...records, ...core].map(r => normTitle(r.title)))
const takenIds = new Set(records.map(r => r.id))
const added = []
for (const item of doaj) {
  if (matched.has(item)) continue
  const bib = item.bibjson
  const issns = [normIssn(bib.eissn), normIssn(bib.pissn)].filter(Boolean)
  if (!issns.length || issns.some(i => known.has(i))) continue
  if (knownTitles.has(normTitle(bib.title))) continue
  const rec = buildRecord(buildFromDoaj({ ...bib, eissn: normIssn(bib.eissn), pissn: normIssn(bib.pissn) }, item))
  if (takenIds.has(rec.id)) continue
  takenIds.add(rec.id)
  for (const i of issns) known.add(i)
  added.push(rec)
}
log(`New journals added from DOAJ: ${added.length}`)
for (const r of added.slice(0, 50)) log(`  + ${r.issn_online ?? r.issn_print ?? ''}  ${r.title}`)
if (added.length > 50) log(`  … and ${added.length - 50} more`)

const out = [...records, ...added]
log(`Discovered records: ${records.length} → ${out.length} (${out.filter(r => r.doaj_status === 'listed').length} DOAJ-listed)`)

if (WRITE) {
  saveDiscovered(out)
  console.error('✓  Wrote the discovered journals file')
} else {
  console.error('Dry run; pass --write to save.')
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### DOAJ sync ${TODAY}\n\n\`\`\`\n${summary.join('\n')}\n\`\`\`\n`)
}
