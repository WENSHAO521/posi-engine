#!/usr/bin/env node
/**
 * fill-subjects.mjs
 *
 * Fetches LCC subjects from DOAJ API for all journals in discovered-journals.json
 * and patches the `subjects:` field in-place.
 *
 * Strategy: query DOAJ by country code (same as --doaj-sweep) to avoid the
 * Elasticsearch 1000-record limit. Build an ISSN→subjects map, then do a
 * single pass over the records in discovered-journals.json.
 *
 * Usage:
 *   node scripts/fill-subjects.mjs [--doaj-key KEY] [--dry-run]
 *   DOAJ_API_KEY=xxx node scripts/fill-subjects.mjs
 */

import { loadDiscovered, saveDiscovered } from './lib/discovered-store.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const DOAJ_KEY = (() => {
  const i = args.indexOf('--doaj-key')
  return i !== -1 ? args[i + 1] : (process.env.DOAJ_API_KEY ?? '')
})()

const COUNTRIES = [
  'AF','AL','DZ','AD','AO','AR','AM','AU','AT','AZ','BH','BD','BY','BE','BJ','BT',
  'BO','BA','BW','BR','BN','BG','BF','BI','KH','CM','CA','CF','CD','TD','CL','CN',
  'CO','CG','HR','CU','CY','CZ','DK','DO','EC','EG','SV','EE','ET','FI','FR','GE',
  'DE','GH','GR','GT','GN','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT',
  'JM','JP','JO','KZ','KE','KW','KG','LA','LV','LB','LT','LU','MK','MG','MW','MY',
  'MV','ML','MT','MR','MX','MD','MN','MA','MZ','MM','NA','NP','NL','NZ','NI','NG',
  'NO','OM','PK','PA','PY','PE','PH','PL','PT','QA','RO','RU','RW','SA','SN','RS',
  'SL','SG','SK','SI','SO','ZA','SS','ES','LK','SD','SE','CH','SY','TW','TJ','TZ',
  'TH','TN','TR','TM','UG','UA','AE','GB','US','UY','UZ','VE','VN','YE','ZM','ZW',
  'PS','XK','ME','MO','HK','PR','TT','MU','CW','BB',
]

const SUBJECTS_SPLIT = [
  'Medicine','Science','Social Sciences','Technology','Agriculture',
  'Education','Law','Language and Literature','Philosophy','History',
  'Geography','Fine Arts','Religion',
]

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'POSI/1.0 fill-subjects mailto:posi@panoramagroup.org' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`)
  }
  return res.json()
}

function extractSubjects(bib) {
  const terms = (bib?.subject ?? [])
    .map(s => s.term)
    .filter(Boolean)
  return [...new Set(terms)]
}

async function fetchByQuery(query) {
  const pageSize = 100
  const map = new Map()
  let page = 1
  while (true) {
    const keyParam = DOAJ_KEY ? `&api_key=${DOAJ_KEY}` : ''
    const url = `https://doaj.org/api/search/journals/${encodeURIComponent(query)}?pageSize=${pageSize}&page=${page}${keyParam}`
    let data
    try { data = await fetchJson(url) }
    catch (e) {
      if (page > 1) break
      process.stderr.write(` [ERR: ${e.message.slice(0, 60)}]`)
      break
    }
    const results = data?.results ?? []
    for (const item of results) {
      const bib = item.bibjson ?? {}
      const subjects = extractSubjects(bib)
      if (!subjects.length) continue
      for (const issn of [bib.pissn, bib.eissn].filter(Boolean)) {
        map.set(issn, subjects)
      }
    }
    if (results.length < pageSize) break
    page++
    await sleep(180)
  }
  return map
}

// ── Collect ISSN→subjects from DOAJ by country sweep ───────────────────────

async function buildSubjectMap() {
  const map = new Map()
  let cc_done = 0

  for (const cc of COUNTRIES) {
    process.stderr.write(`  ${cc}`)
    const query = `bibjson.publisher.country:${cc}`
    let batch
    try { batch = await fetchByQuery(query) }
    catch { batch = new Map() }

    if (batch.size >= 900) {
      process.stderr.write(` (${batch.size}, splitting)`)
      for (const subj of SUBJECTS_SPLIT) {
        const q2 = `bibjson.publisher.country:${cc} AND bibjson.subject.term:"${subj}"`
        const sub = await fetchByQuery(q2)
        for (const [issn, subjects] of sub) {
          if (!map.has(issn)) map.set(issn, subjects)
        }
        await sleep(100)
      }
    } else {
      for (const [issn, subjects] of batch) {
        if (!map.has(issn)) map.set(issn, subjects)
      }
    }

    cc_done++
    process.stderr.write(` ${batch.size}\n`)
    await sleep(150)
  }

  process.stderr.write(`\n  Subject map built: ${map.size} ISSN entries\n`)
  return map
}

// ── Update discovered-journals.json ─────────────────────────────────────────

function patchFile(subjectMap) {
  const records = loadDiscovered()
  const byIssn = new Map()
  for (const r of records) {
    if (r.issn_online) byIssn.set(r.issn_online, r)
    if (r.issn_print) byIssn.set(r.issn_print, r)
  }
  let patched = 0
  let already = 0
  let notFound = 0

  for (const [issn, subjects] of subjectMap) {
    if (!subjects.length) continue
    const r = byIssn.get(issn)
    if (!r) { notFound++; continue }
    if (r.subjects?.length) { already++; continue }
    r.subjects = subjects
    patched++
  }

  process.stderr.write(`\nPatch results:\n`)
  process.stderr.write(`  Patched:       ${patched}\n`)
  process.stderr.write(`  Already had:   ${already}\n`)
  process.stderr.write(`  ISSN not found in file: ${notFound}\n`)

  if (DRY_RUN) {
    process.stderr.write(`\n  --dry-run: file NOT written.\n`)
    return
  }

  saveDiscovered(records)
  process.stderr.write(`\n✓  Wrote updated discovered-journals.json\n`)
}

// ── Main ────────────────────────────────────────────────────────────────────

process.stderr.write('\n🔬  fill-subjects: fetching LCC subjects from DOAJ by country\n\n')

const subjectMap = await buildSubjectMap()
patchFile(subjectMap)
