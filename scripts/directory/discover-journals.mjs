#!/usr/bin/env node
/**
 * discover-journals.mjs
 *
 * Discover journals from external sources and optionally write them directly
 * into src/lib/data.ts as unverified auto-discovered metadata records.
 *
 * Usage:
 *   node scripts/discover-journals.mjs --doaj "<publisher name>"
 *   node scripts/discover-journals.mjs --doaj-all                  # all DOAJ journals
 *   node scripts/discover-journals.mjs --doaj-subject "<subject>"  # filter by subject
 *   node scripts/discover-journals.mjs --crossref-member <id>
 *   node scripts/discover-journals.mjs --ojs <domain>
 *
 *   Add --write to dedup against existing ISSNs and append to DISCOVERED_JOURNALS:
 *   node scripts/discover-journals.mjs --doaj "MDPI AG" --write
 *   node scripts/discover-journals.mjs --doaj-all --write --limit 500
 *   node scripts/discover-journals.mjs --doaj-all --write --resume-page 5
 *
 * Without --write: prints TypeScript blocks to stdout (for manual review).
 * With    --write: deduplicates against data.ts and appends new journals.
 *
 * Requires Node.js 18+
 */

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
import { loadDiscovered, saveDiscovered, knownIssns as knownIssnsOf, DISCOVERED_FILE } from './lib/discovered-store.mjs'
import { isoToCountry } from './lib/country-codes.mjs'
import { slugify, buildFromDoaj, buildRecord } from './lib/doaj-record.mjs'

const UA = 'POSI/0.1 (mailto:posi@panoramagroup.org)'

const args = process.argv.slice(2)
const WRITE_MODE = args.includes('--write')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i !== -1 ? parseInt(args[i + 1], 10) : Infinity
})()
const RESUME_PAGE = (() => {
  const i = args.indexOf('--resume-page')
  return i !== -1 ? parseInt(args[i + 1], 10) : 1
})()
// DOAJ API key — pass via env var DOAJ_API_KEY or --doaj-key <key>
const DOAJ_KEY = (() => {
  const i = args.indexOf('--doaj-key')
  return i !== -1 ? args[i + 1] : (process.env.DOAJ_API_KEY ?? '')
})()

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Helpers ────────────────────────────────────────────────────────────────

function titleCase(str) {
  if (!str) return str
  return str === str.toUpperCase()
    ? str.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    : str
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(20000),
    ...opts,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.json()
}

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`)
  return res.text()
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].trim().replace(/\s+/g, ' ') : null
}
function extractAll(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(m => m[1].trim())
}


function parseIssns(issnArr) {
  const print = issnArr?.find(i => i.type === 'print')?.value ?? null
  const online = issnArr?.find(i => i.type === 'electronic')?.value ?? null
  return { issn_print: print, issn_online: online ?? issnArr?.[0]?.value ?? null }
}



// ── MODE 1: OJS sitewide OAI-PMH ───────────────────────────────────────────

async function discoverOjs(domain) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`
  console.error(`\n🔍  Scanning OJS server: ${base}\n`)

  const setsUrl = `${base}/index.php/index/oai?verb=ListSets`
  console.error(`    Fetching sets: ${setsUrl}`)
  const xml = await fetchXml(setsUrl)

  const setSpecList = extractAll(xml, 'setSpec')
  const setNameList = extractAll(xml, 'setName')

  const journals = []
  for (let i = 0; i < setSpecList.length; i++) {
    if (journals.length >= LIMIT) break
    const spec = setSpecList[i]
    const name = setNameList[i] ?? spec
    const slug = spec.includes(':') ? spec.split(':')[1] : spec
    if (!slug || slug === 'index') continue

    const oaiBase   = `${base}/index.php/${slug}/oai`
    const journalUrl = `${base}/index.php/${slug}`

    let issn_print = null, issn_online = null, articleCount = 0
    try {
      const recordsXml = await fetchXml(`${oaiBase}?verb=ListRecords&metadataPrefix=oai_dc`)
      const sources = extractAll(recordsXml, 'dc:source')
      const issnPattern = /\b(\d{4}-\d{3}[\dX])\b/g
      const issns = new Set()
      for (const s of sources) for (const [, issn] of s.matchAll(issnPattern)) issns.add(issn)
      const issnArr = [...issns]
      if (issnArr.length >= 2) { issnArr.sort(); issn_print = issnArr[0]; issn_online = issnArr[1] }
      else if (issnArr.length === 1) issn_online = issnArr[0]
      const totalMatch = recordsXml.match(/completeListSize="(\d+)"/) ?? recordsXml.match(/totalListSize="(\d+)"/)
      articleCount = totalMatch ? Number(totalMatch[1]) : (recordsXml.match(/<record>/g) ?? []).length
    } catch (e) {
      console.error(`    ⚠  ${slug}: ${e.message}`)
    }

    journals.push({ code: slug, title: name, short_title: name, issn_print, issn_online,
      website_url: journalUrl, oai_base_url: oaiBase, article_count: articleCount })
    console.error(`    ✓  ${slug.padEnd(16)} | ${issn_print ?? '----'} / ${issn_online ?? '----'} | ${articleCount} articles`)
  }
  return journals
}

// ── MODE 2: Crossref Member API ─────────────────────────────────────────────
// The /members/{id}/journals endpoint no longer exists in Crossref API.
// Strategy: page through member /works, collect unique ISSNs, then fetch
// journal-level metadata via GET /journals/{issn} for each unique one.

async function discoverCrossrefMember(memberId) {
  console.error(`\n🔍  Scanning Crossref member ${memberId} works for unique journals\n`)

  // Step 1: collect unique ISSN → container-title from works
  const issnMap = new Map() // issn → {title, publisher}
  let offset = 0
  const rows = 100
  const MAX_PAGES = 20 // scan up to 2000 works max

  for (let page = 0; page < MAX_PAGES && issnMap.size < LIMIT * 3; page++) {
    const url = `https://api.crossref.org/members/${memberId}/works?filter=type:journal-article&rows=${rows}&offset=${offset}&select=ISSN,container-title,issn-type,publisher&mailto=posi@panorama-sg.com`
    console.error(`    Works page ${page + 1}: offset=${offset} (${issnMap.size} journals found so far)`)
    let data
    try { data = await fetchJson(url) } catch { break }
    const items = data?.message?.items ?? []
    if (items.length === 0) break

    for (const item of items) {
      const issn = item.ISSN?.[0]
      if (!issn || issnMap.has(issn)) continue
      const title = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']
      if (title) issnMap.set(issn, { title, publisher: item.publisher ?? '' })
    }
    if (items.length < rows) break
    offset += rows
  }

  console.error(`\n    Found ${issnMap.size} unique journal ISSNs — fetching journal metadata\n`)

  // Step 2: for each unique ISSN, fetch journal metadata
  const journals = []
  for (const [issn, { title, publisher }] of [...issnMap.entries()].slice(0, LIMIT)) {
    let meta = null
    try {
      const r = await fetchJson(
        `https://api.crossref.org/journals/${issn}?mailto=posi@panorama-sg.com`
      )
      meta = r?.message
    } catch { /* use fallback */ }

    const issnTypeArr = (meta?.['issn-type'] ?? [])
    const issn_print  = issnTypeArr.find(i => i.type === 'print')?.value  ?? null
    const issn_online = issnTypeArr.find(i => i.type === 'electronic')?.value ?? issn

    journals.push({
      code: slugify(meta?.title ?? title),
      title: meta?.title ?? title,
      short_title: (meta?.title ?? title).split(':')[0].trim(),
      issn_print,
      issn_online,
      publisher: meta?.publisher ?? publisher,
      country: titleCase(meta?.['publisher-location']) ?? '',
      website_url: '',
      article_count: meta?.counts?.['current-dois'] ?? 0,
    })

    console.error(`    ✓  ${(meta?.title ?? title).slice(0, 44).padEnd(44)} | ${issn_print ?? '----'} / ${issn_online ?? '----'}`)
  }
  return journals
}

// ── MODE 3a: DOAJ — search by publisher name ────────────────────────────────

async function discoverDoaj(publisherQuery) {
  console.error(`\n🔍  Searching DOAJ for publisher: "${publisherQuery}"\n`)

  const pageSize = 100
  let page = 1
  const journals = []

  while (journals.length < LIMIT) {
    const q = encodeURIComponent(`bibjson.publisher.name:"${publisherQuery}"`)
    const keyParam = DOAJ_KEY ? `&api_key=${DOAJ_KEY}` : ''
    const url = `https://doaj.org/api/search/journals/${q}?pageSize=${pageSize}&page=${page}${keyParam}`
    console.error(`    Fetching page ${page}: ${url}`)
    const data = await fetchJson(url)
    const results = data?.results ?? []
    if (results.length === 0) break

    for (const item of results) {
      if (journals.length >= LIMIT) break
      const bib = item.bibjson ?? {}
      const j = buildFromDoaj(bib, item)
      if (!j.publisher) j.publisher = publisherQuery
      journals.push(j)
      console.error(`    ✓  ${(bib.title ?? '?').slice(0, 44).padEnd(44)} | ${j.issn_print ?? '----'} / ${j.issn_online ?? '----'}`)
    }
    if (results.length < pageSize) break
    page++
    await sleep(300)
  }
  return journals
}

// ── MODE 3b: DOAJ — fetch all journals (paginate everything) ─────────────────

async function discoverDoajAll(subjectFilter = '') {
  const label = subjectFilter ? `subject: "${subjectFilter}"` : 'all journals'
  console.error(`\n🔍  Fetching DOAJ ${label} (starting at page ${RESUME_PAGE})\n`)

  const pageSize = 100
  let page = RESUME_PAGE
  const journals = []
  let totalKnown = null

  while (journals.length < LIMIT) {
    const q = subjectFilter
      ? encodeURIComponent(`bibjson.subject.term:"${subjectFilter}"`)
      : encodeURIComponent('_exists_:bibjson.title')
    const keyParam = DOAJ_KEY ? `&api_key=${DOAJ_KEY}` : ''
    const url = `https://doaj.org/api/search/journals/${q}?pageSize=${pageSize}&page=${page}${keyParam}`

    const totalPages = totalKnown ? Math.ceil(totalKnown / pageSize) : '?'
    console.error(`    Page ${page}/${totalPages} — ${journals.length} collected so far...`)

    let data
    try {
      data = await fetchJson(url)
    } catch (e) {
      console.error(`    ⚠  ${e.message} — retrying in 5s`)
      await sleep(5000)
      try { data = await fetchJson(url) } catch (e2) {
        console.error(`    ❌  Skipping page ${page}: ${e2.message}`)
        page++
        continue
      }
    }

    if (totalKnown === null && data.total != null) {
      totalKnown = data.total
      console.error(`    Total available: ${totalKnown} journals`)
    }

    const results = data?.results ?? []
    if (results.length === 0) break

    for (const item of results) {
      if (journals.length >= LIMIT) break
      const bib = item.bibjson ?? {}
      journals.push(buildFromDoaj(bib, item))
    }

    if (results.length < pageSize) break
    page++
    await sleep(300)
  }
  return journals
}

// ── MODE 3c-alt: DOAJ — sweep by country code to bypass page-10 limit ────────
// DOAJ's Elasticsearch rejects offset > 1000 (page > 10 at pageSize=100).
// Workaround: query per country code. Each country is typically < 1000 journals,
// so stays within the limit. Countries with > 1000 journals are split by subject.

const DOAJ_COUNTRIES = [
  'AF','AL','DZ','AD','AO','AR','AM','AU','AT','AZ','BH','BD','BY','BE','BJ','BT',
  'BO','BA','BW','BR','BN','BG','BF','BI','KH','CM','CA','CF','TD','CL','CN','CO',
  'CG','HR','CU','CY','CZ','DK','DO','EC','EG','SV','EE','ET','FI','FR','GE','DE',
  'GH','GR','GT','GN','HT','HN','HU','IS','IN','ID','IR','IQ','IE','IL','IT','JM',
  'JP','JO','KZ','KE','KW','KG','LA','LV','LB','LT','LU','MK','MG','MW','MY','MV',
  'ML','MT','MR','MX','MD','MN','MA','MZ','MM','NA','NP','NL','NZ','NI','NG','NO',
  'OM','PK','PA','PY','PE','PH','PL','PT','QA','RO','RU','RW','SA','SN','RS','SL',
  'SG','SK','SI','SO','ZA','SS','ES','LK','SD','SE','CH','SY','TW','TJ','TZ','TH',
  'TN','TR','TM','UG','UA','AE','GB','US','UY','UZ','VE','VN','YE','ZM','ZW','PS',
  'XK','BA','ME','MO','HK','PR','TT','MU','CW','BB','LC','VC','GD','KY','BM','JE',
]

// Subjects used as a second-level split for large countries (> 900 journals)
const DOAJ_SUBJECTS_SPLIT = [
  'Medicine','Science','Social Sciences','Technology','Agriculture',
  'Education','Law','Language and Literature','Philosophy','History',
  'Geography','Fine Arts','Religion',
]

async function doajFetchByQuery(query, label) {
  const pageSize = 100
  const journals = []
  let page = 1
  while (journals.length < LIMIT) {
    const keyParam = DOAJ_KEY ? `&api_key=${DOAJ_KEY}` : ''
    const url = `https://doaj.org/api/search/journals/${encodeURIComponent(query)}?pageSize=${pageSize}&page=${page}${keyParam}`
    let data
    try { data = await fetchJson(url) }
    catch (e) {
      if (page > 1) break   // stop gracefully on deep-page errors
      console.error(`    ⚠  ${label}: ${e.message}`)
      break
    }
    const results = data?.results ?? []
    for (const item of results) {
      if (journals.length >= LIMIT) break
      journals.push(buildFromDoaj(item.bibjson ?? {}, item))
    }
    if (results.length < pageSize) break
    page++
    await sleep(200)
  }
  return journals
}

async function discoverDoajCountrySweep() {
  console.error('\n🔍  DOAJ country sweep — querying each country separately\n')
  const allJournals = []
  const seen = new Set()

  for (const cc of DOAJ_COUNTRIES) {
    if (allJournals.length >= LIMIT) break
    const query = `bibjson.publisher.country:${cc}`
    const batch = await doajFetchByQuery(query, cc)

    // If a country returns 900+ it likely has more; re-split by subject
    if (batch.length >= 900) {
      console.error(`    ${cc}: ${batch.length} (large — splitting by subject)`)
      for (const subj of DOAJ_SUBJECTS_SPLIT) {
        if (allJournals.length >= LIMIT) break
        const q2 = `bibjson.publisher.country:${cc} AND bibjson.subject.term:"${subj}"`
        const sub = await doajFetchByQuery(q2, `${cc}/${subj}`)
        for (const j of sub) {
          const key = j.issn_online ?? j.issn_print ?? j.code
          if (!seen.has(key)) { seen.add(key); allJournals.push(j) }
        }
        await sleep(100)
      }
    } else {
      console.error(`    ${cc}: ${batch.length}`)
      for (const j of batch) {
        const key = j.issn_online ?? j.issn_print ?? j.code
        if (!seen.has(key)) { seen.add(key); allJournals.push(j) }
      }
    }
    await sleep(150)
  }

  console.error(`\n  Total collected: ${allJournals.length}`)
  return allJournals
}

// ── MODE 3c: OpenAlex — fetch all DOAJ journals via cursor (no 10k limit) ────

async function discoverOpenAlexDoaj() {
  console.error('\n🔍  Fetching DOAJ journals via OpenAlex cursor API (no page limit)\n')

  const perPage = 200
  let cursor = '*'
  const journals = []
  let totalKnown = null
  let pageNum = 0

  while (journals.length < LIMIT) {
    const url = `https://api.openalex.org/sources?filter=is_in_doaj:true&per-page=${perPage}&cursor=${encodeURIComponent(cursor)}&mailto=posi@panoramagroup.org`

    pageNum++
    const totalPages = totalKnown ? Math.ceil(totalKnown / perPage) : '?'
    console.error(`    Page ${pageNum}/${totalPages} — ${journals.length} collected so far...`)

    let data = null
    for (let attempt = 1; attempt <= 5 && data === null; attempt++) {
      try {
        data = await fetchJson(url)
      } catch (e) {
        if (attempt === 5) {
          console.error(`    ❌  Fatal after 5 attempts: ${e.message}`)
          break
        }
        console.error(`    ⚠  ${e.message} — retrying in ${attempt * 3}s (attempt ${attempt}/5)`)
        await sleep(attempt * 3000)
      }
    }
    if (data === null) break

    if (totalKnown === null && data?.meta?.count != null) {
      totalKnown = data.meta.count
      console.error(`    Total available: ${totalKnown} journals`)
    }

    const results = data?.results ?? []
    if (results.length === 0) break

    for (const src of results) {
      if (journals.length >= LIMIT) break

      const issns = src.issn ?? []
      const issn_online = src.issn_l ?? issns[0] ?? null
      const issn_print  = issns.find(i => i !== issn_online) ?? null
      const primaryIssn = issn_online ?? issn_print

      const code = primaryIssn ? `issn-${primaryIssn}` : slugify(src.display_name ?? '').slice(0, 24)

      // Simplified scoring from OpenAlex data (no DOAJ bibjson license/review details)
      const has_apc      = (src.apc_usd ?? 0) > 0
      const has_dual     = issns.length >= 2
      const jtf = Math.min(8 + (has_apc ? 4 : 5), 25)
      const mqf = Math.min(8 + (has_dual ? 3 : 1), 25)
      const egf = 6   // base only — no peer-review detail available from OpenAlex, not assumed
      const tdf = 5   // base only
      const cvf = 3   // base only
      const rif = 2   // base only — DOAJ/OpenAlex listing is not treated as peer-review evidence

      journals.push({
        code,
        title:          src.display_name ?? 'Unknown',
        short_title:    (src.display_name ?? 'Unknown').split(':')[0].trim(),
        issn_print,
        issn_online,
        publisher:      src.host_organization_name ?? '',
        country:        isoToCountry(src.country_code),
        registration_country: isoToCountry(src.country_code) || null,
        language:       'English',
        frequency:      '',
        peer_review_type: 'Peer review',
        license:        'Open Access',
        website_url:    src.homepage_url ?? '',
        oai_base_url:   null,
        doaj_status:    'listed',
        article_count:  src.works_count ?? 0,
        _scores: { jtf, mqf, egf, tdf, cvf, rif },
      })
    }

    const nextCursor = data?.meta?.next_cursor
    if (!nextCursor || results.length < perPage) break
    cursor = nextCursor
    await sleep(120)  // OpenAlex allows ~10 req/s; 120ms is safe
  }

  return journals
}

// ── Write mode: dedup + append to discovered-journals.json ────────────────

function writeDiscovered(journals) {
  const records = loadDiscovered()
  const knownIssns = knownIssnsOf(records)

  // Filter out duplicates (match on either ISSN)
  let newJournals = journals.filter(j => {
    if (j.issn_online && knownIssns.has(j.issn_online)) return false
    if (j.issn_print  && knownIssns.has(j.issn_print))  return false
    return true
  })

  if (newJournals.length === 0) {
    console.error('\n✓  No new journals (all already recorded by ISSN).')
    return
  }

  // Deduplicate within the discovered list (same online or print ISSN = same journal)
  const seenIssn = new Set()
  const deduped = newJournals.filter(j => {
    const key = j.issn_online ?? j.issn_print ?? j.code
    if (seenIssn.has(key)) return false
    seenIssn.add(key)
    if (j.issn_print)  seenIssn.add(j.issn_print)
    if (j.issn_online) seenIssn.add(j.issn_online)
    return true
  })
  const removed = newJournals.length - deduped.length
  newJournals = deduped

  console.error(`\nDeduplication: ${journals.length} discovered → ${newJournals.length} new (${journals.length - newJournals.length + removed} already known or duplicate)\n`)

  saveDiscovered([...records, ...newJournals.map(buildRecord)])
  console.error(`✓  Appended ${newJournals.length} new journal(s) to ${DISCOVERED_FILE}`)
  for (const j of newJournals) {
    console.error(`   + ${(j.code ?? '').padEnd(24)} ${j.issn_online ?? j.issn_print ?? ''}  ${j.title?.slice(0, 44)}`)
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

let journals = []

if (args[0] === '--ojs' && args[1]) {
  journals = await discoverOjs(args[1])
} else if (args[0] === '--crossref-member' && args[1]) {
  journals = await discoverCrossrefMember(args[1])
} else if (args[0] === '--doaj' && args[1]) {
  journals = await discoverDoaj(args[1])
} else if (args[0] === '--doaj-all') {
  journals = await discoverDoajAll()
} else if (args[0] === '--doaj-subject' && args[1]) {
  journals = await discoverDoajAll(args[1])
} else if (args[0] === '--openalex-doaj') {
  journals = await discoverOpenAlexDoaj()
} else if (args[0] === '--doaj-sweep') {
  journals = await discoverDoajCountrySweep()
} else {
  console.error(`
Usage:
  node scripts/discover-journals.mjs --ojs <domain>              [--write] [--limit N]
  node scripts/discover-journals.mjs --crossref-member <id>      [--write] [--limit N]
  node scripts/discover-journals.mjs --doaj "<publisher name>"   [--write] [--limit N]
  node scripts/discover-journals.mjs --doaj-all                  [--write] [--limit N] [--resume-page N]
  node scripts/discover-journals.mjs --doaj-subject "<subject>"  [--write] [--limit N]
  node scripts/discover-journals.mjs --openalex-doaj             [--write] [--limit N]
  node scripts/discover-journals.mjs --doaj-sweep                [--write] [--doaj-key KEY]

Examples:
  node scripts/discover-journals.mjs --openalex-doaj --write           # all DOAJ via OpenAlex
  node scripts/discover-journals.mjs --doaj-sweep --write --doaj-key KEY  # all DOAJ direct API
  node scripts/discover-journals.mjs --doaj "MDPI AG" --write
  node scripts/discover-journals.mjs --doaj-subject "Medicine" --write --limit 200
  node scripts/discover-journals.mjs --crossref-member 1968 --write --limit 30
  node scripts/discover-journals.mjs --ojs ojs.shiharr.com --write

Without --write: prints TypeScript blocks to stdout for manual review.
With    --write: deduplicates and appends new journals to DISCOVERED_JOURNALS in data.ts.
  --doaj-sweep: queries DOAJ by country code to bypass the 1000-record per-query limit
  --openalex-doaj: cursor-based, no 10,000 result limit
`)
  process.exit(1)
}

if (journals.length === 0) {
  console.error('\n⚠  No journals discovered.')
  process.exit(0)
}

console.error(`\n✓  Discovered ${journals.length} journals.`)

if (WRITE_MODE) {
  writeDiscovered(journals)
} else {
  // Print to stdout for manual review / paste
  console.error('─'.repeat(60))
  // One JSON record per line (dry run; pass --write to append them).
  for (const j of journals) console.log(JSON.stringify(buildRecord(j)))
}
