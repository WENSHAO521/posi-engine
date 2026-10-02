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
 *   - works:    the Crossref fetch returned 200.
 * A journal with no stored snapshot always takes the fresh one.
 *
 * Exits 1 when no fresh file at all was usable (the run itself was broken),
 * so the scheduled rerate stops instead of rating from stale evidence
 * without anyone noticing.
 *
 * Usage:
 *   node scripts/apply-evidence-refresh.mjs --kind journals|works --from <ETL out>/journals --to <posi-data>/evidence/<kind>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

export function reachedSource(kind, result) {
  if (kind === 'journals') return (result?.fetched_pages ?? []).some(p => p.fetch_status === 'ok')
  if (kind === 'works') return result?.crossref_status === 200
  throw new Error(`unknown evidence kind: ${kind}`)
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : null
}

function main() {
  const kind = arg('kind')
  const from = resolve(arg('from'))
  const to = resolve(arg('to'))
  let replaced = 0, added = 0
  const kept = []
  for (const file of readdirSync(from).filter(f => f.endsWith('.json')).sort()) {
    const raw = readFileSync(join(from, file), 'utf-8')
    const target = join(to, file)
    if (!existsSync(target)) { writeFileSync(target, raw, 'utf-8'); added++; continue }
    if (reachedSource(kind, JSON.parse(raw))) { writeFileSync(target, raw, 'utf-8'); replaced++; continue }
    kept.push(file.replace(/\.json$/, ''))
  }
  console.log(`${kind}: ${replaced} replaced, ${added} added, ${kept.length} kept (source not reached)${kept.length ? ': ' + kept.join(', ') : ''}`)
  if (replaced + added === 0 && kept.length > 0) {
    console.error(`No fresh ${kind} evidence reached its source; the ETL run looks broken`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
