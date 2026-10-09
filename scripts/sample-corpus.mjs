#!/usr/bin/env node
/**
 * sample-corpus.mjs — a deterministic sample of a corpus, stratified by
 * website host, for trying an ETL on a large corpus before running it in
 * full (e.g. whether publisher platforms let the site crawl through).
 *
 * Only journals AJR can rate on the given date are drawn (Early-Stage or
 * Mature, LIFECYCLE-1.1). Hosts get seats in proportion to their journal
 * count, every host gets at least one while seats last (largest hosts
 * first), and within a host journals are spread evenly over posi_id order.
 *
 * Usage:
 *   node scripts/sample-corpus.mjs --corpus <corpus JSON> --n 50 --out sample.json [--date YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { classifyLifecycle } from '../src/lifecycle.mjs'
import { withoutWithdrawn } from '../src/withdrawn.mjs'

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, '') } catch { return '(no website)' }
}

/**
 * @param {object[]} journals
 * @param {number} n
 * @returns {object[]}
 */
export function stratifiedSample(journals, n) {
  const groups = new Map()
  for (const j of [...journals].sort((a, b) => String(a.posi_id).localeCompare(String(b.posi_id)))) {
    const h = hostOf(j.website_url)
    if (!groups.has(h)) groups.set(h, [])
    groups.get(h).push(j)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  const total = journals.length
  const seats = new Map(sorted.map(([h, list]) => [h, Math.min(list.length, Math.floor((n * list.length) / total))]))
  let used = [...seats.values()].reduce((s, v) => s + v, 0)
  for (const [h, list] of sorted) {
    if (used >= n) break
    if (seats.get(h) === 0 && list.length > 0) { seats.set(h, 1); used++ }
  }
  for (const [h, list] of sorted) {
    while (used < n && seats.get(h) < list.length) { seats.set(h, seats.get(h) + 1); used++ }
    if (used >= n) break
  }
  const out = []
  for (const [h, list] of sorted) {
    const k = seats.get(h)
    for (let i = 0; i < k; i++) out.push(list[Math.floor((i * list.length) / k)])
  }
  return out
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function main() {
  const raw = JSON.parse(readFileSync(resolve(arg('corpus')), 'utf-8'))
  const corpus = withoutWithdrawn(Array.isArray(raw) ? raw : (raw.journals ?? []))
  const asOf = new Date(`${arg('date', new Date().toISOString().slice(0, 10))}T00:00:00Z`)
  const rateable = corpus.filter(j => ['early_stage', 'mature'].includes(classifyLifecycle(j.early_stage_rating?.first_published ?? null, asOf).lifecycle_stage))
  const sample = stratifiedSample(rateable, Number(arg('n', '50')))
  mkdirSync(dirname(resolve(arg('out'))), { recursive: true })
  writeFileSync(resolve(arg('out')), JSON.stringify(sample, null, 2) + '\n', 'utf-8')
  const hosts = {}
  for (const j of sample) hosts[hostOf(j.website_url)] = (hosts[hostOf(j.website_url)] ?? 0) + 1
  console.log(`${sample.length} of ${rateable.length} rateable journals (${corpus.length} in corpus)`)
  console.log(JSON.stringify(hosts))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
