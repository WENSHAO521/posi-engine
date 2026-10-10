#!/usr/bin/env node
/**
 * crawl-crossref-member.mjs
 *
 * Lists a publisher's journals from Crossref: the ISSNs of the member's
 * journal articles in a date window, those not already in posi-data's
 * registry, each looked up at /journals/<issn> and merged by journal, then
 * checked against DOAJ. The output is the candidates file that
 * posi-data/scripts/ingest-crossref-publisher.mjs turns into registry rows and
 * discovered records.
 *
 * Crossref has no "journals of member N" endpoint, so the ISSN facet of
 * /members/<id>/works is read per date window and a window that reaches the
 * facet cap (1,000 values) is split in half until it does not.
 *
 * Usage:
 *   node scripts/crawl-crossref-member.mjs --member 311 --since 2018-01-01 \
 *     --registry posi-data/registry/journal-id-map.csv --out candidates.json [--min-issns 500]
 *
 * --since defaults to 120 days ago (the monthly run). A scan that reads fewer
 * than --min-issns ISSNs fails without writing, so a Crossref outage is not
 * mistaken for a month with no new journals.
 */
import { readFileSync, writeFileSync } from 'fs'

const MAILTO = 'posi@panorama-sg.com'
const UA = `POSI/0.1 (mailto:${MAILTO})`
const FACET_CAP = 1000

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
const member = arg('member')
const registryFile = arg('registry')
const outFile = arg('out')
if (!member || !registryFile || !outFile) {
  console.error('Usage: node scripts/crawl-crossref-member.mjs --member <id> --registry <journal-id-map.csv> --out <file> [--since YYYY-MM-DD] [--min-issns N]')
  process.exit(2)
}
const TODAY = new Date().toISOString().slice(0, 10)
const since = arg('since', new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10))
const minIssns = parseInt(arg('min-issns', '1'), 10)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const day = s => new Date(s + 'T00:00:00Z')
const iso = d => d.toISOString().slice(0, 10)

async function getJson(url) {
  let last
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).message
    } catch (e) {
      last = e
      await sleep(3000 * (attempt + 1))
    }
  }
  throw new Error(`${last.message} - ${url}`)
}

async function scan(from, until, found) {
  const filter = `type:journal-article,from-pub-date:${from},until-pub-date:${until}`
  const msg = await getJson(`https://api.crossref.org/members/${member}/works?rows=0&facet=issn:*&filter=${filter}&mailto=${MAILTO}`)
  const keys = Object.keys(msg?.facets?.issn?.values ?? {})
  if (keys.length >= FACET_CAP && from !== until) {
    const a = day(from), b = day(until)
    const mid = new Date(a.getTime() + Math.floor((b - a) / 2 / 864e5) * 864e5)
    await scan(from, iso(mid), found)
    await scan(iso(new Date(mid.getTime() + 864e5)), until, found)
    return
  }
  for (const k of keys) found.add(k.slice(k.lastIndexOf('/') + 1)) // https://id.crossref.org/issn/1234-5678
}

// ISSNs the registry already knows, as an ISSN-L or as one half of a pair.
const known = new Set()
for (const line of readFileSync(registryFile, 'utf8').trim().split('\n').slice(1)) {
  const [, type, value] = line.split(',')
  if (type === 'issn_l') known.add(value)
  else if (type === 'issn_pair') value.split('/').forEach(v => known.add(v))
}

console.error(`Crossref member ${member}: scanning ${since} to ${TODAY}`)
const found = new Set()
const end = day(TODAY)
for (let d = day(since); d <= end; ) {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  const last = new Date(Math.min(next - 864e5, end))
  await scan(iso(d), iso(last), found)
  console.error(`  to ${iso(last)}: ${found.size} ISSNs`)
  d = next
}
if (found.size < minIssns) {
  console.error(`Read ${found.size} ISSNs, fewer than --min-issns ${minIssns}; not writing.`)
  process.exit(1)
}

const todo = [...found].filter(i => !known.has(i))
console.error(`${found.size} ISSNs read, ${todo.length} not in the registry`)
const candidates = []
const done = new Set()
for (const issn of todo) {
  if (done.has(issn)) continue
  const m = await getJson(`https://api.crossref.org/journals/${issn}?mailto=${MAILTO}`)
  if (!m) continue
  const all = [...new Set(m.ISSN ?? [issn])]
  all.forEach(x => done.add(x))
  if (all.some(x => known.has(x))) continue
  candidates.push({
    title: m.title, publisher: m.publisher, ISSN: all, 'issn-type': m['issn-type'] ?? [],
    dois: m.counts?.['total-dois'] ?? 0, subjects: (m.subjects ?? []).map(s => s.name),
  })
  await sleep(100)
}

const listed = new Set()
const issns = candidates.flatMap(c => c.ISSN)
for (let i = 0; i < issns.length; i += 40) {
  const q = issns.slice(i, i + 40).map(x => `issn:"${x}"`).join(' OR ')
  try {
    const res = await fetch(`https://doaj.org/api/search/journals/${encodeURIComponent(q)}?pageSize=100`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })
    if (res.ok) for (const j of (await res.json()).results ?? []) for (const x of [j.bibjson?.eissn, j.bibjson?.pissn]) if (x) listed.add(x)
  } catch { /* left as not listed; a later DOAJ sync corrects it */ }
  await sleep(400)
}
for (const c of candidates) c.doaj = c.ISSN.some(x => listed.has(x))

writeFileSync(outFile, JSON.stringify(candidates))
console.log(`${candidates.length} candidate journals (${candidates.filter(c => c.doaj).length} in DOAJ) -> ${outFile}`)
