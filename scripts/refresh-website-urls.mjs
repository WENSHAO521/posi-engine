#!/usr/bin/env node
/**
 * refresh-website-urls.mjs — finds corpus records whose website_url no
 * longer leads anywhere (retired platforms such as blackwellpublishing.com
 * or springerlink.com) or that have none, and replaces them with the
 * journal's homepage_url from its OpenAlex source record when that one
 * answers (src/website-url.mjs decides).
 *
 * Writes the corpus with the changed website_url values (--out, may be the
 * input) and a report of every journal checked (--report, JSON + CSV).
 *
 * Usage:
 *   node scripts/refresh-website-urls.mjs --corpus <corpus JSON> --out <corpus JSON> --report <dir>
 *     [--only-rateable] [--concurrency 8] [--limit N]
 *
 * --only-rateable checks only the journals AJR can rate today (Early-Stage
 * or Mature), the ones the evidence crawl visits.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { fetchWithStatus } from '../src/evidence-fetch.mjs'
import { decideWebsiteUrl } from '../src/website-url.mjs'
import { classifyLifecycle } from '../src/lifecycle.mjs'

const OPENALEX = 'https://api.openalex.org'
const MAILTO = 'posi@panorama-sg.com'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

// Liveness only: the body is not needed, so a small cap keeps big pages cheap.
async function check(url) {
  if (!url) return null
  const once = () => fetchWithStatus(url, { timeoutMs: 20000, maxBodyBytes: 256 * 1024 })
  let r = await once()
  if (['timeout', 'network_error'].includes(r.fetch_status)) r = await once()
  return { fetch_status: r.fetch_status, http_status: r.http_status }
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
  if (arg('limit')) targets = targets.slice(0, Number(arg('limit')))
  console.log(`Checking ${targets.length} of ${corpus.length} journals`)

  const rows = await pool(targets, Number(arg('concurrency', '8')), async (j, i) => {
    const current = j.website_url || null
    const currentCheck = await check(current)
    let candidate = null, candidateCheck = null
    if (!current || currentCheck?.fetch_status !== 'ok') {
      candidate = await openalexHomepage(j.openalex_source_id)
      candidateCheck = await check(candidate)
    }
    const d = decideWebsiteUrl({ current, currentCheck, candidate, candidateCheck })
    if (d.action !== 'keep') console.log(`[${i + 1}/${targets.length}] ${j.posi_id} ${d.action}: ${current ?? '-'} -> ${d.url ?? '-'} (${d.reason})`)
    return { posi_id: j.posi_id, title: j.title, current, current_status: currentCheck?.http_status ?? currentCheck?.fetch_status ?? null, candidate, candidate_status: candidateCheck?.http_status ?? candidateCheck?.fetch_status ?? null, ...d }
  })

  const byId = new Map(rows.filter(r => r.action === 'add' || r.action === 'replace').map(r => [r.posi_id, r.url]))
  const updated = corpus.map(j => (byId.has(j.posi_id) ? { ...j, website_url: byId.get(j.posi_id) } : j))
  writeFileSync(resolve(arg('out')), JSON.stringify(Array.isArray(raw) ? updated : { ...raw, journals: updated }, null, 2) + '\n', 'utf-8')

  const counts = rows.reduce((m, r) => { m[r.action] = (m[r.action] ?? 0) + 1; return m }, {})
  const reportDir = resolve(arg('report'))
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'website-urls.json'), JSON.stringify({ checked: rows.length, counts, rows }, null, 2) + '\n', 'utf-8')
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  writeFileSync(join(reportDir, 'website-urls.csv'), ['posi_id,title,action,current,current_status,new,candidate_status,reason']
    .concat(rows.map(r => [r.posi_id, esc(r.title), r.action, esc(r.current), r.current_status ?? '', esc(r.action === 'add' || r.action === 'replace' ? r.url : ''), r.candidate_status ?? '', esc(r.reason)].join(','))).join('\n') + '\n', 'utf-8')
  console.log(JSON.stringify(counts))
}

main().catch(err => { console.error(err); process.exit(1) })
