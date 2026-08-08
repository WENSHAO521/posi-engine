#!/usr/bin/env node
/**
 * enrich-openalex.mjs
 *
 * OpenAlex identity enrichment over candidate-entities.jsonl (dedupe.mjs's
 * output). For every unique valid ISSN across all candidates, does a
 * singleton "get source by ISSN" lookup (GET /sources/issn:{issn}), caches
 * the raw response to disk (resumable — a killed/interrupted run picks back
 * up without re-querying already-cached ISSNs), classifies each candidate's
 * enrichment status, and re-scores dedupe.mjs's possible_duplicates using
 * the enrichment evidence. Does NOT auto-merge any candidate entities and
 * does NOT touch citation-impact fields (see openalex-enrich.mjs's header).
 *
 * Usage:
 *   OPENALEX_API_KEY=... node scripts/enrich-openalex.mjs \
 *     --entities path/to/candidate-entities.jsonl \
 *     --possible-duplicates path/to/possible-duplicates.csv \
 *     --cache-dir path/to/cache \
 *     --out path/to/output-dir \
 *     [--limit N] [--concurrency 8]
 *
 * OPENALEX_API_KEY is optional (singleton lookups are unauthenticated-
 * friendly per OpenAlex's docs) but recommended — read from the environment
 * only, never hardcoded, never written into any output file.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { fetchOpenAlexSourceByIssn, classifyEnrichment } from '../src/migration/openalex-enrich.mjs'
import { rescoreAll } from '../src/migration/rescore-duplicates.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function issnCacheKey(issn) {
  return issn.replace('/', '_') // ISSNs never contain '/', defensive only
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** Simple bounded-concurrency queue. */
async function runWithConcurrency(items, concurrency, worker) {
  let i = 0
  let completed = 0
  const results = new Array(items.length)
  async function next() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await worker(items[idx], idx)
      completed++
      if (completed % 500 === 0) console.log(`  ... ${completed}/${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
  return results
}

async function lookupWithRetry(issn, { apiKey, cacheDir }) {
  const cacheFile = join(cacheDir, `${issnCacheKey(issn)}.json`)
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'))
  }

  const maxAttempts = 5
  let lastResult = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchOpenAlexSourceByIssn(issn, { apiKey })
    lastResult = result
    // 404 is a legitimate answer, not a failure — don't retry it.
    if (result.status === 404 || result.status === 200) break
    // Retry on rate limiting, server errors, or network-level failures (status === null).
    const retryable = result.status === 429 || (result.status != null && result.status >= 500) || result.status === null
    if (!retryable || attempt === maxAttempts) break
    const backoffMs = 2 ** attempt * 500
    await sleep(backoffMs)
  }

  const record = { queried_issn: issn, retrieved_at: new Date().toISOString(), ...lastResult }
  writeFileSync(cacheFile, JSON.stringify(record), 'utf-8')
  return record
}

function parseCsv(text) {
  const lines = text.trim().split('\n')
  const header = lines[0].split(',')
  return lines.slice(1).map(line => {
    // Minimal CSV parser sufficient for this file's own csvEscape() output (audit.mjs).
    const cells = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') inQuotes = false
        else cur += c
      } else {
        if (c === '"') inQuotes = true
        else if (c === ',') { cells.push(cur); cur = '' }
        else cur += c
      }
    }
    cells.push(cur)
    const row = {}
    header.forEach((h, i) => { row[h] = cells[i] })
    return row
  })
}

async function main() {
  const entitiesPath = arg('entities')
  const possibleDuplicatesPath = arg('possible-duplicates')
  const cacheDir = resolve(arg('cache-dir', 'openalex-cache'))
  const outDir = resolve(arg('out', 'openalex-enrichment-output'))
  const limit = arg('limit') ? parseInt(arg('limit'), 10) : null
  const concurrency = arg('concurrency') ? parseInt(arg('concurrency'), 10) : 8
  const apiKey = process.env.OPENALEX_API_KEY || undefined

  if (!entitiesPath) {
    console.error('Usage: node scripts/enrich-openalex.mjs --entities <candidate-entities.jsonl> --out <dir>')
    process.exit(1)
  }
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  let entities = readFileSync(resolve(entitiesPath), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  if (limit) entities = entities.slice(0, limit)
  console.log(`Loaded ${entities.length} candidate entities.`)

  const allIssns = [...new Set(entities.flatMap(e => e.issn_set ?? []))]
  const alreadyCached = new Set(readdirSync(cacheDir).map(f => f.replace(/\.json$/, '')))
  console.log(`${allIssns.length} unique ISSNs to resolve (${allIssns.filter(i => alreadyCached.has(issnCacheKey(i))).length} already cached from a prior run).`)

  const startTime = Date.now()
  const lookupResults = await runWithConcurrency(allIssns, concurrency, issn => lookupWithRetry(issn, { apiKey, cacheDir }))
  const issnToResult = new Map(allIssns.map((issn, i) => [issn, lookupResults[i]]))
  console.log(`Resolved all ISSNs in ${((Date.now() - startTime) / 1000).toFixed(1)}s.`)

  const statusCounts = {}
  const enrichmentByCandidateId = new Map()
  const enrichmentRecords = entities.map(e => {
    const verdict = classifyEnrichment(e.issn_set ?? [], issnToResult)
    statusCounts[verdict.status] = (statusCounts[verdict.status] ?? 0) + 1
    enrichmentByCandidateId.set(e.candidate_id, verdict)
    return { candidate_id: e.candidate_id, ...verdict }
  })

  writeFileSync(join(outDir, 'candidate-enrichment.jsonl'), enrichmentRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8')

  let rescoredCounts = null
  if (possibleDuplicatesPath && existsSync(resolve(possibleDuplicatesPath))) {
    const rows = parseCsv(readFileSync(resolve(possibleDuplicatesPath), 'utf-8'))
    const groups = rows.map(r => ({
      title: r.title, publisher: r.publisher,
      legacy_ids: r.legacy_ids.split(';'),
      candidate_entities: r.candidate_entities.split(';'),
    }))
    const rescored = rescoreAll(groups, enrichmentByCandidateId)
    rescoredCounts = {}
    for (const g of rescored) rescoredCounts[g.rescoring] = (rescoredCounts[g.rescoring] ?? 0) + 1

    const csvHeader = 'title,publisher,legacy_ids,candidate_entities,rescoring\n'
    const csvBody = rescored.map(g =>
      [g.title, g.publisher, g.legacy_ids.join(';'), g.candidate_entities.join(';'), g.rescoring]
        .map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')
    ).join('\n')
    writeFileSync(join(outDir, 'rescored-possible-duplicates.csv'), csvHeader + csvBody + '\n', 'utf-8')
    console.log('Rescored possible duplicates:', rescoredCounts)
  }

  const summary = {
    generated_at: new Date().toISOString(),
    candidates_processed: entities.length,
    unique_issns_queried: allIssns.length,
    status_counts: statusCounts,
    possible_duplicate_rescoring: rescoredCounts,
  }
  writeFileSync(join(outDir, 'enrichment-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8')

  console.log('\nStatus breakdown:', statusCounts)
  console.log(`\nWrote output to ${outDir}`)
}

main().catch(err => { console.error(err); process.exit(1) })
