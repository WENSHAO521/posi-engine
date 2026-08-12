#!/usr/bin/env node
/**
 * verify-benchmark-counts.mjs
 *
 * Reconciliation check: compares the CURRENT corpus/global-benchmark.json
 * and registry/journal-id-map.csv record counts against an
 * expected-count.json fixture committed alongside a migration's audit
 * report (e.g. audits/migrations/elsevier-jnlactive-expansion-2026/
 * expected-count.json). A pipeline change that silently shifts the count
 * (4106 -> 4288, or 4300) should fail this check rather than rely on
 * someone remembering the right number.
 *
 * Also asserts registry/superseded-ids.csv (if present) passes its own
 * invariants -- no cycle, no duplicate old_posi_id, no chain, every
 * superseded_by_posi_id actually exists in the registry.
 *
 * Usage:
 *   node scripts/verify-benchmark-counts.mjs \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --registry <path to registry/journal-id-map.csv> \
 *     --expected <path to expected-count.json> \
 *     [--superseded <path to registry/superseded-ids.csv>]
 *
 * Exit code 0 = all checks pass. Exit code 1 = reconciliation failure.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { validateSupersessionRows } from '../src/migration/supersession.mjs'
import { parseCsv } from '../src/showjcr/csv.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function parseRegistryCsv(text) {
  const lines = text.trim().split('\n')
  const header = lines[0].split(',')
  return lines.slice(1).map(l => { const p = l.split(','); const o = {}; header.forEach((h, i) => o[h] = p[i]); return o })
}

/** The `reason` column contains free text with commas -- must use the
 * real RFC4180 parser, not a naive split. */
function parseSupersededCsv(text) {
  const { rows } = parseCsv(text)
  return rows.map(r => ({ old_posi_id: r.old_posi_id, superseded_by_posi_id: r.superseded_by_posi_id }))
}

function main() {
  const benchmarkPath = resolve(arg('benchmark'))
  const registryPath = resolve(arg('registry'))
  const expectedPath = resolve(arg('expected'))
  const supersededPath = arg('superseded')

  const failures = []

  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))
  const registryRows = parseRegistryCsv(readFileSync(registryPath, 'utf-8'))
  const expected = JSON.parse(readFileSync(expectedPath, 'utf-8'))

  console.log(`Actual:   global_benchmark_count=${benchmark.length}, registry_row_count=${registryRows.length}`)
  console.log(`Expected: global_benchmark_count=${expected.global_benchmark_count}, registry_row_count=${expected.registry_row_count}`)

  if (benchmark.length !== expected.global_benchmark_count) {
    failures.push(`RECONCILIATION WARNING: global-benchmark.json has ${benchmark.length} records, expected ${expected.global_benchmark_count} (per ${expectedPath}). If this change is intentional, update the fixture; if not, something in the pipeline shifted.`)
  }
  if (registryRows.length !== expected.registry_row_count) {
    failures.push(`RECONCILIATION WARNING: journal-id-map.csv has ${registryRows.length} rows, expected ${expected.registry_row_count} (per ${expectedPath}).`)
  }

  const missingPosiId = benchmark.filter(r => !r.posi_id).length
  if (missingPosiId > 0) failures.push(`${missingPosiId} benchmark record(s) missing posi_id`)

  const posiIdCounts = new Map()
  for (const r of benchmark) { if (r.posi_id) posiIdCounts.set(r.posi_id, (posiIdCounts.get(r.posi_id) ?? 0) + 1) }
  const duplicates = [...posiIdCounts.entries()].filter(([, c]) => c > 1)
  if (duplicates.length > 0) failures.push(`${duplicates.length} duplicate posi_id assignment(s): ${duplicates.map(([id]) => id).join(', ')}`)

  if (supersededPath && existsSync(resolve(supersededPath))) {
    const supersessionRows = parseSupersededCsv(readFileSync(resolve(supersededPath), 'utf-8'))
    const knownPosiIds = new Set(registryRows.map(r => r.posi_id))
    const { valid, errors } = validateSupersessionRows(supersessionRows, { knownPosiIds })
    if (!valid) failures.push(...errors.map(e => `superseded-ids.csv: ${e}`))
    else console.log(`superseded-ids.csv: ${supersessionRows.length} row(s), all invariants pass.`)
  }

  if (failures.length > 0) {
    console.error('\n=== FAILURES ===')
    failures.forEach(f => console.error(`  - ${f}`))
    process.exit(1)
  }
  console.log('\nAll reconciliation checks pass.')
}

main()
