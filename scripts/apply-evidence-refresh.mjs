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
 *   - journals: at least one fetched page came back 'ok', or the journal's
 *               Crossref deposits were read (EC-1.1; a site that refuses
 *               every request can still be resolved from them);
 *   - works:    the Crossref fetch returned 200;
 *   - output:   the OpenAlex source record was read (counts_by_year set).
 * A journal with no stored snapshot always takes the fresh one. A site
 * crawl that was cut short by its host (evidence_snapshot_status
 * partial_source_unavailable) never replaces a stored complete one: a few
 * timeouts on the day must not turn a rated journal not-rateable. Likewise,
 * when the fresh run's Crossref fetch failed, the stored snapshot's
 * Crossref-resolved items are carried over (mergeJournalSnapshot): an API
 * outage must not undo evidence found before.
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
import { evidenceSnapshotStatus } from '../src/evidence-fetch.mjs'
import { evidenceCoverage, dimensionScore } from '../src/evidence-coverage.mjs'
import { EVIDENCE_CRITERIA } from '../src/evidence-resolver.mjs'

const reachedSite = result => (result?.fetched_pages ?? []).some(p => p.fetch_status === 'ok')

export function reachedSource(kind, result) {
  if (kind === 'journals') {
    return reachedSite(result)
      || (result?.crossref_evidence != null && !result.crossref_evidence.failed && result.crossref_evidence.articles > 0)
  }
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
  // The guard compares site crawls: a stored snapshot that reached only
  // Crossref is not a complete crawl to protect.
  if (kind === 'journals' && fresh.evidence_snapshot_status === 'partial_source_unavailable'
    && storedStatus(stored) === 'complete' && reachedSite(stored)) return false
  return true
}

/**
 * The journal snapshot to store: the fresh one, except that when its
 * Crossref fetch failed, items the stored snapshot had resolved from
 * Crossref (and the fresh one left unknown/blocked) are carried over, as
 * long as the sample they came from still ends inside the fresh run's
 * three-year window (crossref_until between its since and until): evidence
 * from after the rating date, or aged out of the window, is not carried.
 * Coverage and dimension scores are recomputed.
 * @param {object} fresh
 * @param {object|null} stored
 */
export function mergeJournalSnapshot(fresh, stored) {
  if (!stored || !fresh?.crossref_evidence?.failed) return fresh
  const { since, until } = fresh.crossref_evidence
  const inWindow = i => typeof i.crossref_until === 'string' && since && until && i.crossref_until >= since && i.crossref_until <= until
  const prior = new Map((stored.evidence_items ?? []).filter(i => i.source === 'crossref' && i.status === 'met' && inWindow(i)).map(i => [i.id, i]))
  if (!prior.size) return fresh
  let carried = 0
  const items = (fresh.evidence_items ?? []).map(i => {
    const p = prior.get(i.id)
    if (!p || !['unknown', 'blocked'].includes(i.status)) return i
    carried++
    return { ...p, carried_over_from: stored.snapshot_date ?? null }
  })
  if (!carried) return fresh
  const coverage = evidenceCoverage(items)
  const dimensionScores = {}
  for (const dim of Object.keys(fresh.dimension_scores ?? {})) {
    const dimItems = items.filter(i => EVIDENCE_CRITERIA.find(c => c.id === i.id)?.dimension === dim)
    dimensionScores[dim] = dimensionScore(dimItems, dimItems.reduce((s, i) => s + i.weight, 0))
  }
  return {
    ...fresh, evidence_items: items, coverage, site_evidence_coverage_percent: coverage.coverage_percent,
    ...(fresh.dimension_scores ? { dimension_scores: dimensionScores } : {}),
    crossref_evidence: { ...fresh.crossref_evidence, carried_over: carried },
  }
}

// A snapshot written before evidence_snapshot_status existed: infer it from
// its page statuses.
function storedStatus(stored) {
  return stored.evidence_snapshot_status ?? evidenceSnapshotStatus(stored.fetched_pages).evidence_snapshot_status
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
    const freshResult = JSON.parse(raw), stored = JSON.parse(readFileSync(target, 'utf-8'))
    if (shouldReplace(kind, freshResult, stored)) {
      writeFileSync(target, kind === 'journals' ? JSON.stringify(mergeJournalSnapshot(freshResult, stored), null, 2) : raw, 'utf-8')
      replaced++
      continue
    }
    kept.push(file.replace(/\.json$/, ''))
  }
  console.log(`${kind}: ${replaced} replaced, ${added} added, ${kept.length} kept (source not reached, or cut short where a complete crawl is stored)${kept.length ? ': ' + kept.join(', ') : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
