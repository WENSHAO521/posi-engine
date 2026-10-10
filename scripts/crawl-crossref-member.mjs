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
 * --since defaults to 120 days ago (the monthly run). --date-field says which
 * Crossref date the window is on: `created` (when the DOI was first deposited;
 * the default for the monthly run, so a journal that starts depositing a back
 * catalogue is found when it does) or `pub` (publication date; the default
 * when --since is given, for a historical pass over articles published since
 * then). A scan that reads fewer than --min-issns ISSNs fails without writing,
 * so a Crossref outage is not mistaken for a month with no new journals; so
 * does a single day that still reaches the facet cap, and a DOAJ lookup that
 * keeps failing (a journal is never recorded as subscription because DOAJ
 * could not be reached).
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
const sinceArg = arg('since')
const since = sinceArg ?? new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10)
const dateField = arg('date-field', sinceArg ? 'pub' : 'created')
if (!['pub', 'created'].includes(dateField)) { console.error('--date-field must be pub or created'); process.exit(2) }
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

async function facetIssns(from, until, extra = '') {
  const filter = `type:journal-article,from-${dateField}-date:${from},until-${dateField}-date:${until}${extra}`
  const msg = await getJson(`https://api.crossref.org/members/${member}/works?rows=0&facet=issn:*&filter=${filter}&mailto=${MAILTO}`)
  return Object.keys(msg?.facets?.issn?.values ?? {})
}

let prefixes = null
async function memberPrefixes() {
  prefixes ??= ((await getJson(`https://api.crossref.org/members/${member}?mailto=${MAILTO}`))?.prefix ?? []).map(p => p.value)
  return prefixes
}

// Crossref ISSNs look like https://id.crossref.org/issn/1234-5678
const addKeys = (found, keys) => keys.forEach(k => found.add(k.slice(k.lastIndexOf('/') + 1)))

async function scan(from, until, found) {
  const keys = await facetIssns(from, until)
  if (keys.length < FACET_CAP) return addKeys(found, keys)
  if (from !== until) {
    const a = day(from), b = day(until)
    const mid = new Date(a.getTime() + Math.floor((b - a) / 2 / 864e5) * 864e5)
    await scan(from, iso(mid), found)
    await scan(iso(new Date(mid.getTime() + 864e5)), until, found)
    return
  }
  // One day still reaches the facet cap: read it again per DOI prefix of the member. If a prefix alone
  // still reaches the cap, stop rather than carry on with a list that is cut off without any sign of it.
  for (const prefix of await memberPrefixes()) {
    const part = await facetIssns(from, until, `,prefix:${prefix}`)
    if (part.length >= FACET_CAP) throw new Error(`${from}, prefix ${prefix}: ${part.length} ISSNs reach the facet cap; the list would be incomplete`)
    addKeys(found, part)
  }
}

// ISSNs the registry already knows, as an ISSN-L or as one half of a pair.
const known = new Set()
for (const line of readFileSync(registryFile, 'utf8').trim().split('\n').slice(1)) {
  const [, type, value] = line.split(',')
  if (type === 'issn_l') known.add(value)
  else if (type === 'issn_pair') value.split('/').forEach(v => known.add(v))
}

console.error(`Crossref member ${member}: scanning ${since} to ${TODAY} by ${dateField} date`)
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

// A DOAJ batch that cannot be read is retried and then fails the run: treating it as "not listed" would
// record open access journals as subscription journals.
async function doajBatch(issnBatch) {
  const q = issnBatch.map(x => `issn:"${x}"`).join(' OR ')
  let last
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://doaj.org/api/search/journals/${encodeURIComponent(q)}?pageSize=100`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).results ?? []
    } catch (e) {
      last = e
      await sleep(3000 * (attempt + 1))
    }
  }
  throw new Error(`DOAJ lookup failed (${last.message}) for ${issnBatch.slice(0, 3).join(', ')}...`)
}

const listed = new Set()
const issns = candidates.flatMap(c => c.ISSN)
for (let i = 0; i < issns.length; i += 40) {
  for (const j of await doajBatch(issns.slice(i, i + 40))) for (const x of [j.bibjson?.eissn, j.bibjson?.pissn]) if (x) listed.add(x)
  await sleep(400)
}
for (const c of candidates) c.doaj = c.ISSN.some(x => listed.has(x))

writeFileSync(outFile, JSON.stringify(candidates))
console.log(`${candidates.length} candidate journals (${candidates.filter(c => c.doaj).length} in DOAJ) -> ${outFile}`)
