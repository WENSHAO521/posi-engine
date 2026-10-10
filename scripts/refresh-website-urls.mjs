#!/usr/bin/env node
/**
 * refresh-website-urls.mjs — finds corpus records whose website_url no
 * longer leads anywhere (retired platforms such as blackwellpublishing.com
 * or springerlink.com) or that have none, and replaces them with the first
 * candidate that answers (src/website-url.mjs decides): the journal's
 * homepage_url in OpenAlex, its official website in Wikidata (P856, looked
 * up by ISSN), then a publisher address built from the ISSN (Wiley). The
 * last two must answer 200 with a page that names the journal, and
 * catalogue sites (Google Books, OCLC, JSTOR...) never count.
 *
 * Writes the corpus with the changed website_url values (--out, may be the
 * input) and a report of every journal checked (--report, JSON + CSV), and
 * prints a Markdown table of every journal not kept as it is.
 *
 * --curated <JSON> adds hand-picked addresses ({ entries: [{ posi_id, title,
 * url }] }, config/website-url-curated.json) as the first candidate after
 * OpenAlex. Each must still answer, and is ignored when its title is not
 * the corpus record's (a wrong posi_id never changes another journal).
 *
 * Usage:
 *   node scripts/refresh-website-urls.mjs --corpus <corpus JSON> --out <corpus JSON> --report <dir>
 *     [--curated <JSON>] [--only-rateable] [--concurrency 8] [--limit N]
 *
 * --only-rateable checks only the journals AJR can rate today (Early-Stage
 * or Mature), the ones the evidence crawl visits.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { fetchWithStatus } from '../src/evidence-fetch.mjs'
import { decideWebsiteUrl, liveness, publisherRewrites, parseWikidataSites, pageMentionsTitle } from '../src/website-url.mjs'
import { classifyLifecycle } from '../src/lifecycle.mjs'
import { withoutWithdrawn } from '../src/withdrawn.mjs'

const OPENALEX = 'https://api.openalex.org'
const MAILTO = 'posi@panorama-sg.com'
const WIKIDATA = 'https://query.wikidata.org/sparql'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

// Liveness, and with a title whether the page names the journal; a cap
// keeps big pages cheap.
async function check(url, title = null) {
  if (!url) return null
  // Reading the title needs the page; liveness alone does not.
  const once = () => fetchWithStatus(url, { timeoutMs: 20000, maxBodyBytes: title ? 4 * 1024 * 1024 : 256 * 1024 })
  let r = await once()
  if (['timeout', 'network_error'].includes(r.fetch_status)) r = await once()
  return { fetch_status: r.fetch_status, http_status: r.http_status, ...(title ? { mentions_title: !!r.body && pageMentionsTitle(r.body, title) } : {}) }
}

async function openalexHomepage(sourceId) {
  const id = (sourceId ?? '').replace(/^https?:\/\/openalex\.org\//, '')
  if (!/^S\d+$/.test(id)) return null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${OPENALEX}/sources/${id}?select=homepage_url&mailto=${MAILTO}`, { signal: AbortSignal.timeout(15000) })
      if (res.status === 404) return null
      if (res.ok) return (await res.json()).homepage_url ?? null
    } catch { /* retried */ }
    await new Promise(r => setTimeout(r, 1000 * attempt))
  }
  return null
}

// Official websites for many ISSNs at once (one SPARQL query per 50).
// A failed batch only leaves its journals without a Wikidata candidate.
async function wikidataSites(issns) {
  const all = new Map()
  for (let i = 0; i < issns.length; i += 50) {
    const values = issns.slice(i, i + 50).map(x => JSON.stringify(x)).join(' ')
    const query = `SELECT ?issn ?site WHERE { VALUES ?issn { ${values} } ?j wdt:P236|wdt:P7363 ?issn; wdt:P856 ?site }`
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${WIKIDATA}?query=${encodeURIComponent(query)}`, {
          headers: { Accept: 'application/sparql-results+json', 'User-Agent': `posi-engine/1.0 (mailto:${MAILTO})` },
          signal: AbortSignal.timeout(60000),
        })
        if (res.ok) { for (const [k, v] of parseWikidataSites(await res.json())) all.set(k, v); break }
        console.warn(`Wikidata batch ${i / 50 + 1}: HTTP ${res.status}`)
      } catch (e) { console.warn(`Wikidata batch ${i / 50 + 1}: ${e.message}`) }
      await new Promise(r => setTimeout(r, 5000 * attempt))
    }
  }
  return all
}

const issnsOf = j => [j.issn_online, j.issn_print].filter(Boolean).map(i => i.toUpperCase())

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) }
  }))
  return out
}

async function main() {
  const raw = JSON.parse(readFileSync(resolve(arg('corpus')), 'utf-8'))
  const corpus = Array.isArray(raw) ? raw : (raw.journals ?? [])
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
  let targets = process.argv.includes('--only-rateable')
    ? corpus.filter(j => ['early_stage', 'mature'].includes(classifyLifecycle(j.early_stage_rating?.first_published ?? null, today).lifecycle_stage))
    : corpus
  // Withdrawn journals are not checked, but stay in the corpus that is written back.
  targets = withoutWithdrawn(targets, 'website check')
  if (arg('limit')) targets = targets.slice(0, Number(arg('limit')))
  const concurrency = Number(arg('concurrency', '8'))
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency must be a positive integer, got ${arg('concurrency')}`)
  console.log(`Checking ${targets.length} of ${corpus.length} journals`)

  // Pass 1: the recorded address, and OpenAlex where it is dead or missing.
  const first = await pool(targets, concurrency, async j => {
    const current = j.website_url || null
    const currentCheck = await check(current)
    const candidates = []
    if (!current || liveness(currentCheck) === 'dead') {
      const url = await openalexHomepage(j.openalex_source_id)
      if (url) candidates.push({ url, check: await check(url), source: 'openalex' })
    }
    return { j, current, currentCheck, candidates }
  })

  const curated = new Map()
  if (arg('curated')) {
    for (const e of JSON.parse(readFileSync(resolve(arg('curated')), 'utf-8')).entries ?? []) {
      const j = corpus.find(x => x.posi_id === e.posi_id)
      if (!j || j.title !== e.title) { console.warn(`Curated ${e.posi_id} ignored: title is ${j ? JSON.stringify(j.title) : 'not in the corpus'}, not ${JSON.stringify(e.title)}`); continue }
      curated.set(e.posi_id, e.url)
    }
  }

  // Pass 2, only for journals still without a working address: a curated
  // address, Wikidata's official website, then the publisher's ISSN address.
  const stuck = first.filter(r => ['dead_no_replacement', 'missing_no_replacement'].includes(decideWebsiteUrl(r).action))
  const wd = stuck.length ? await wikidataSites([...new Set(stuck.flatMap(r => issnsOf(r.j)))]) : new Map()
  console.log(`Second pass: ${stuck.length} journals; Wikidata has a website for ${stuck.filter(r => issnsOf(r.j).some(i => wd.has(i))).length}`)
  await pool(stuck, concurrency, async r => {
    const seen = new Set(r.candidates.map(c => c.url))
    const more = [
      ...(curated.has(r.j.posi_id) ? [{ url: curated.get(r.j.posi_id), source: 'curated' }] : []),
      ...[...new Set(issnsOf(r.j).flatMap(i => wd.get(i) ?? []))].map(url => ({ url, source: 'wikidata', strict: true })),
      ...publisherRewrites(r.j).map(url => ({ url, source: 'publisher_rewrite', strict: true })),
    ].filter(c => !seen.has(c.url) && seen.add(c.url))
    for (const c of more) r.candidates.push({ ...c, check: await check(c.url, r.j.title) })
  })

  const rows = first.map(({ j, current, currentCheck, candidates }, i) => {
    const d = decideWebsiteUrl({ current, currentCheck, candidates })
    if (d.action !== 'keep') console.log(`[${i + 1}/${targets.length}] ${j.posi_id} ${d.action}: ${current ?? '-'} -> ${d.url ?? '-'} (${d.reason})`)
    return {
      posi_id: j.posi_id, title: j.title, publisher: j.publisher ?? null, current,
      current_status: currentCheck?.http_status ?? currentCheck?.fetch_status ?? null,
      candidates: candidates.map(c => ({ source: c.source, url: c.url, status: `${c.check?.http_status ?? c.check?.fetch_status ?? '?'}${c.check?.mentions_title === false ? ', title not on page' : ''}` })),
      ...d,
    }
  })

  const byId = new Map(rows.filter(r => r.action === 'add' || r.action === 'replace').map(r => [r.posi_id, r.url]))
  const updated = corpus.map(j => (byId.has(j.posi_id) ? { ...j, website_url: byId.get(j.posi_id) } : j))
  writeFileSync(resolve(arg('out')), JSON.stringify(Array.isArray(raw) ? updated : { ...raw, journals: updated }, null, 2) + '\n', 'utf-8')

  const counts = rows.reduce((m, r) => { m[r.action] = (m[r.action] ?? 0) + 1; return m }, {})
  const reportDir = resolve(arg('report'))
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'website-urls.json'), JSON.stringify({ checked: rows.length, counts, rows }, null, 2) + '\n', 'utf-8')
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  writeFileSync(join(reportDir, 'website-urls.csv'), ['posi_id,title,publisher,action,current,current_status,new,source,candidates,reason']
    .concat(rows.map(r => [r.posi_id, esc(r.title), esc(r.publisher), r.action, esc(r.current), r.current_status ?? '', esc(r.action === 'add' || r.action === 'replace' ? r.url : ''), r.source ?? '', esc(r.candidates.map(c => `${c.source} ${c.url} ${c.status}`).join(' | ')), esc(r.reason)].join(','))).join('\n') + '\n', 'utf-8')
  console.log(JSON.stringify(counts))

  const md = v => String(v ?? '–').replace(/\|/g, '\\|')
  const lines = [`## Website URLs: ${rows.length} checked`, '', '| Action | Count |', '|---|---|', ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`), '',
    '| POSI ID | Title | Publisher | Action | Recorded | New | Source | Candidates tried |', '|---|---|---|---|---|---|---|---|',
    ...rows.filter(r => r.action !== 'keep').map(r => `| ${r.posi_id} | ${md(r.title)} | ${md(r.publisher)} | ${r.action} | ${md(r.current)} (${r.current_status ?? '–'}) | ${r.action === 'add' || r.action === 'replace' ? md(r.url) : '–'} | ${r.source ?? '–'} | ${md(r.candidates.map(c => `${c.source}: ${c.url} (${c.status})`).join('; ') || 'none')} |`)]
  writeFileSync(join(reportDir, 'website-urls.md'), lines.join('\n') + '\n', 'utf-8')
}

main().catch(err => { console.error(err); process.exit(1) })
