#!/usr/bin/env node
/**
 * fix-frontiers-website-2026.mjs
 *
 * Cross-references source-lists/frontiers-titlelist-web-2026.csv (Frontiers
 * Media's own title list, distributed via the Swiss Academic Libraries
 * consortium) against the Global Benchmark Collection records whose
 * `publisher` field matches "Frontiers", to fix stale `website_url` values
 * -- same pattern as the earlier Elsevier website_url fix
 * (audits/data-quality/elsevier-website-fix-2026/).
 *
 * The CSV has an 11-line preamble (consortium metadata) before the real
 * `Journal,ISSN,URL` header -- this script skips to that header before
 * parsing with src/showjcr/csv.mjs's RFC4180-correct parseCsv().
 *
 * Usage:
 *   node scripts/fix-frontiers-website-2026.mjs \
 *     --csv <path to frontiers-titlelist-web-2026.csv> \
 *     --benchmark <path to corpus/global-benchmark.json> \
 *     --out <output dir> \
 *     [--apply]   (without --apply, dry-run only: report proposed fixes, write no files to --benchmark)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { parseCsv } from '../src/showjcr/csv.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

const ISSN_PATTERN = /^\d{4}-\d{3}[\dXx]$/

function parseFrontiersCsv(text) {
  const lines = text.split('\n')
  const headerLineIdx = lines.findIndex(l => l.startsWith('Journal,ISSN'))
  if (headerLineIdx === -1) throw new Error('Could not find "Journal,ISSN" header row in CSV')
  const { rows } = parseCsv(lines.slice(headerLineIdx).join('\n'))
  return rows
    .map(r => ({ issn: (r.ISSN || '').trim(), url: (r.URL || '').trim(), title: (r.Journal || '').trim() }))
    .filter(r => ISSN_PATTERN.test(r.issn))
}

function main() {
  const csvPath = resolve(arg('csv'))
  const benchmarkPath = resolve(arg('benchmark'))
  const outDir = resolve(arg('out', 'frontiers-website-fix-output'))
  const apply = flag('apply')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const csvRows = parseFrontiersCsv(readFileSync(csvPath, 'utf-8'))
  const csvByIssn = new Map(csvRows.map(r => [r.issn, r]))
  const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf-8'))

  const frontiersRecords = benchmark.filter(r => /frontiers/i.test(r.publisher || ''))
  console.log(`CSV rows with ISSN: ${csvRows.length}. Existing Frontiers-publisher Global Benchmark records: ${frontiersRecords.length}.`)

  const fixes = []
  const noCsvMatch = []
  for (const rec of frontiersRecords) {
    // ingest-frontiers-2026.mjs (fixed 2026-08-13) no longer writes a
    // kind-unspecified CSV ISSN into issn_online -- it's kept as `issn`
    // instead. Checking all three keeps this matching records ingested
    // either before or after that fix.
    const issn = rec.issn_online || rec.issn_print || rec.issn
    const csvRow = issn ? csvByIssn.get(issn) : null
    if (!csvRow) { noCsvMatch.push({ id: rec.id, title: rec.title, issn }); continue }
    if (csvRow.url && csvRow.url !== rec.website_url) {
      fixes.push({ id: rec.id, title: rec.title, issn, old_url: rec.website_url, new_url: csvRow.url })
    }
  }

  console.log(`Records with a stale/differing website_url: ${fixes.length}`)
  console.log(`Records with no ISSN match in the CSV (left untouched): ${noCsvMatch.length}`)

  if (apply && fixes.length > 0) {
    const fixMap = new Map(fixes.map(f => [f.id, f.new_url]))
    const updated = benchmark.map(r => fixMap.has(r.id) ? { ...r, website_url: fixMap.get(r.id), updated_at: new Date().toISOString() } : r)
    writeFileSync(benchmarkPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
    console.log(`Applied ${fixes.length} website_url fixes to ${benchmarkPath}`)
  }

  writeFileSync(join(outDir, 'website-url-fixes.json'), JSON.stringify(fixes, null, 2), 'utf-8')
  writeFileSync(join(outDir, 'no-csv-match.json'), JSON.stringify(noCsvMatch, null, 2), 'utf-8')
  const summary = {
    csv_rows_with_issn: csvRows.length,
    existing_frontiers_benchmark_records: frontiersRecords.length,
    website_url_fixes_found: fixes.length,
    website_url_fixes_applied: apply ? fixes.length : 0,
    no_csv_match: noCsvMatch.length,
    dry_run: !apply,
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main()
