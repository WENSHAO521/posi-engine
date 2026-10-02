#!/usr/bin/env node
/**
 * apply-evidence-refresh.mjs — copies a fresh Evidence ETL / Article-Sample
 * ETL run over posi-data's evidence directory, journal by journal, keeping
 * the stored snapshot wherever the fresh one never reached its source.
 *
 * Both ETLs write a result for every journal, even when every request
 * failed (a site that blocks the crawler, a Crossref outage): such a result
 * has 0% coverage / an empty article sample, and copying it over would turn
 * a working rating into not_rateable for reasons that have nothing to do
 * with the journal. So a fresh file replaces the stored one only when
 *   - journals: at least one fetched page came back 'ok';
 *   - works:    the Crossref fetch returned 200;
 *   - output:   the OpenAlex source record was read (counts_by_year set).
 * A journal with no stored snapshot always takes the fresh one. A site
 * crawl that was cut short by its host (evidence_snapshot_status
 * partial_source_unavailable) never replaces a stored complete one: a few
 * timeouts on the day must not turn a rated journal not-rateable.
 *
 * Exits 1, applying nothing, when no fresh file at all reached its source
 * (the run itself was broken), so the scheduled rerate stops instead of
 * rating from stale or empty evidence without anyone noticing.
 *
 * Usage:
 *   node scripts/apply-evidence-refresh.mjs --kind journals|works|output --from <ETL out>/journals --to <posi-data>/evidence/<kind>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

export function reachedSource(kind, result) {
  if (kind === 'journals') return (result?.fetched_pages ?? []).some(p => p.fetch_status === 'ok')
  if (kind === 'works') return result?.crossref_status === 200
  if (kind === 'output') return result?.counts_by_year != null
  throw new Error(`unknown evidence kind: ${kind}`)
}

/**
 * Whether a fresh snapshot replaces the stored one.
 * @param {string} kind
 * @param {object} fresh
 * @param {object|null} stored - null when nothing is stored yet
 */
export function shouldReplace(kind, fresh, stored) {
  if (!stored) return true
  if (!reachedSource(kind, fresh)) return false
  if (kind === 'journals' && fresh.evidence_snapshot_status === 'partial_source_unavailable'
    && stored.evidence_snapshot_status === 'complete') return false
  return true
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : null
}

function main() {
  const kind = arg('kind')
  const from = resolve(arg('from'))
  const to = resolve(arg('to'))
  const fresh = readdirSync(from).filter(f => f.endsWith('.json')).sort()
    .map(file => ({ file, raw: readFileSync(join(from, file), 'utf-8') }))
  for (const f of fresh) f.reached = reachedSource(kind, JSON.parse(f.raw))
  if (fresh.length > 0 && !fresh.some(f => f.reached)) {
    console.error(`No fresh ${kind} evidence reached its source (${fresh.length} files); the ETL run looks broken, nothing applied`)
    process.exit(1)
  }
  mkdirSync(to, { recursive: true })
  let replaced = 0, added = 0
  const kept = []
  for (const { file, raw } of fresh) {
    const target = join(to, file)
    if (!existsSync(target)) { writeFileSync(target, raw, 'utf-8'); added++; continue }
    if (shouldReplace(kind, JSON.parse(raw), JSON.parse(readFileSync(target, 'utf-8')))) { writeFileSync(target, raw, 'utf-8'); replaced++; continue }
    kept.push(file.replace(/\.json$/, ''))
  }
  console.log(`${kind}: ${replaced} replaced, ${added} added, ${kept.length} kept (source not reached, or cut short where a complete crawl is stored)${kept.length ? ': ' + kept.join(', ') : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
