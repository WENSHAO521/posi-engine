#!/usr/bin/env node
/**
 * summarize-evidence-trial.mjs — what an ETL trial on a sample got: per
 * website host, how many pages were fetched / refused / timed out and the
 * site evidence coverage; whether Crossref answered; and the AJR-M rating
 * outcome with its most common reasons. Prints Markdown (for the job
 * summary) and writes the same as JSON.
 *
 * Usage:
 *   node scripts/summarize-evidence-trial.mjs --sample sample.json --evidence-journals <dir> \
 *     --evidence-works <dir> --mature-report <rate-mature report dir> --out summary.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : null
}
const load = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null)
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, '') } catch { return '(no website)' } }
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null)

const sample = load(resolve(arg('sample')))
const hosts = new Map()
let crossrefOk = 0
for (const j of sample) {
  const h = hostOf(j.website_url)
  if (!hosts.has(h)) hosts.set(h, { journals: 0, pages: {}, coverage: [], reached: 0 })
  const g = hosts.get(h)
  g.journals++
  const ev = load(join(resolve(arg('evidence-journals')), `${j.posi_id}.json`))
  for (const p of ev?.fetched_pages ?? []) g.pages[p.fetch_status] = (g.pages[p.fetch_status] ?? 0) + 1
  if ((ev?.fetched_pages ?? []).some(p => p.fetch_status === 'ok')) g.reached++
  if (ev) g.coverage.push(ev.site_evidence_coverage_percent ?? 0)
  const w = load(join(resolve(arg('evidence-works')), `${j.posi_id}.json`))
  if (w?.crossref_status === 200) crossrefOk++
}

const rows = [...hosts.entries()].sort((a, b) => b[1].journals - a[1].journals).map(([h, g]) => {
  const total = Object.values(g.pages).reduce((s, v) => s + v, 0)
  return {
    host: h, journals: g.journals, site_reached: g.reached,
    pages: total, ok_pct: pct(g.pages.ok ?? 0, total), forbidden_pct: pct((g.pages.forbidden ?? 0) + (g.pages.robots_blocked ?? 0), total),
    timeout_pct: pct((g.pages.timeout ?? 0) + (g.pages.network_error ?? 0) + (g.pages.server_error ?? 0), total),
    mean_site_coverage: g.coverage.length ? Math.round(g.coverage.reduce((s, v) => s + v, 0) / g.coverage.length) : null,
  }
})

const mature = load(join(resolve(arg('mature-report')), 'rate-mature-summary.json'))
const csvPath = join(resolve(arg('mature-report')), 'per-journal-mature.csv')
const reasons = {}
if (existsSync(csvPath)) {
  for (const line of readFileSync(csvPath, 'utf-8').trim().split('\n').slice(1)) {
    const m = line.match(/"([^"]*)"\s*$/)
    for (const r of (m?.[1] ?? '').split('; ').filter(Boolean)) {
      const key = r.replace(/\d+(\.\d+)?/g, 'N')
      reasons[key] = (reasons[key] ?? 0) + 1
    }
  }
}

const summary = { journals: sample.length, crossref_ok: crossrefOk, hosts: rows, ajr_m: mature, ajr_m_reasons: reasons }
writeFileSync(resolve(arg('out')), JSON.stringify(summary, null, 2) + '\n', 'utf-8')

console.log(`## Evidence trial: ${sample.length} journals\n`)
console.log(`Crossref answered for ${crossrefOk} of ${sample.length}.\n`)
console.log('| Host | Journals | Site reached | Pages | OK % | Refused % | Timeout/error % | Mean site coverage % |')
console.log('|---|---:|---:|---:|---:|---:|---:|---:|')
for (const r of rows) console.log(`| ${r.host} | ${r.journals} | ${r.site_reached} | ${r.pages} | ${r.ok_pct ?? ''} | ${r.forbidden_pct ?? ''} | ${r.timeout_pct ?? ''} | ${r.mean_site_coverage ?? ''} |`)
console.log('\n### AJR-M\n')
console.log('```json\n' + JSON.stringify(mature, null, 2) + '\n```\n')
console.log('| Reason not rated | Journals |\n|---|---:|')
for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`| ${r} | ${c} |`)
