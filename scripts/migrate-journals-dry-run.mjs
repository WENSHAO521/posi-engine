#!/usr/bin/env node
/**
 * migrate-journals-dry-run.mjs
 *
 * Runs the full dry-run pipeline (normalize -> identity -> dedupe -> audit)
 * against a migration-source.jsonl file (see the Legacy Export Adapter in
 * the website repo that produces it). Writes an audit report only —
 * generates NO POSI-J ids and writes nothing to posi-data/journals/.
 *
 * Usage:
 *   node scripts/migrate-journals-dry-run.mjs \
 *     --in path/to/migration-source.jsonl \
 *     --out path/to/output-dir \
 *     [--source-repository owner/repo] \
 *     [--source-commit <sha>] \
 *     [--spec-commit <sha>]
 *
 * generator_commit (this repo's provenance field) is always this repo's
 * current HEAD — which is only trustworthy as "checkout this to reproduce
 * the run" if the working tree is clean. If it isn't, this script prints a
 * loud warning: publish the audit only after committing and re-running, not
 * before (see audits/migrations/initial-journal-migration/PROVENANCE-NOTE.md
 * in posi-data for the incident that motivated this check).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { normalizeRecord } from '../src/migration/normalize.mjs'
import { buildCandidateEntities } from '../src/migration/dedupe.mjs'
import { buildAuditReport } from '../src/migration/audit.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.') }).toString().trim()
  } catch {
    return 'unknown'
  }
}

function warnIfWorkingTreeDirty() {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: resolve('.') }).toString()
    if (status.trim().length > 0) {
      console.warn('\n⚠️  WARNING: posi-engine working tree has uncommitted changes.')
      console.warn('   generator_commit will record a commit that does NOT reproduce this exact run.')
      console.warn('   Commit first, then re-run, before publishing this audit anywhere.\n')
    }
  } catch {
    // git not available or not a repo — nothing useful to check
  }
}

function main() {
  const inPath = arg('in')
  const outDir = resolve(arg('out', 'migration-audit-output'))
  if (!inPath) {
    console.error('Usage: node scripts/migrate-journals-dry-run.mjs --in <migration-source.jsonl> --out <output-dir>')
    process.exit(1)
  }

  warnIfWorkingTreeDirty()

  const raw = readFileSync(resolve(inPath), 'utf-8').trim().split('\n').filter(Boolean)
  const sourceRecords = raw.map(line => JSON.parse(line))
  console.log(`Read ${sourceRecords.length} source records from ${inPath}`)

  const normalizedRecords = []
  const warningsPerRecord = []
  for (const rec of sourceRecords) {
    const { normalized, warnings } = normalizeRecord(rec)
    normalizedRecords.push(normalized)
    warningsPerRecord.push(warnings)
  }
  console.log('Normalized all records.')

  const dedupe = buildCandidateEntities(normalizedRecords)
  console.log(`Built ${dedupe.entities.length} candidate entities (${dedupe.hardConflicts.length} hard conflicts, ${dedupe.possibleDuplicates.length} possible-duplicate groups).`)

  const report = buildAuditReport({
    sourceRecords,
    normalizedRecords,
    warningsPerRecord,
    dedupe,
    meta: {
      source_repository: arg('source-repository', 'unknown'),
      source_commit: arg('source-commit', 'unknown'),
      source_file: 'migration-source.jsonl',
      generator_commit: currentCommit(),
      spec_commit: arg('spec-commit', 'unknown'),
      generated_at: new Date().toISOString(),
    },
  })

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  for (const [filename, content] of Object.entries(report.files)) {
    writeFileSync(join(outDir, filename), content, 'utf-8')
  }

  console.log(`\nWrote audit report to ${outDir}:`)
  for (const filename of Object.keys(report.files)) console.log(`  - ${filename}`)
  console.log('\n' + report.md.split('## Next steps')[0])
}

main()
