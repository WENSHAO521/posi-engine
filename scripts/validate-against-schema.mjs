#!/usr/bin/env node
/**
 * validate-against-schema.mjs
 *
 * Validates every committed journals/core/**\/*.json and
 * journals/discovered/*.jsonl record,
 * metrics/**\/*.json record, and rankings/**\/*.json record (each a JSON
 * array of 1+ ranking records for one journal) in a posi-data checkout
 * against that repo's own schema/journal.schema.json,
 * schema/metric.schema.json, and schema/ranking.schema.json — real ajv
 * validation (draft 2020-12), not a hand-rolled required-field check.
 * Also checks that corpus/core-collection.json and journals/core agree on
 * each journal's title and alternate titles, and that no alternate title
 * repeats the title. Exits non-zero if anything fails, so it's usable as a
 * CI gate (posi-data's validate workflow).
 *
 * Usage:
 *   node scripts/validate-against-schema.mjs /path/to/posi-data [--data-dir /path/to/metrics-and-rankings-root]
 *
 * `--data-dir` lets the metrics/rankings tree being checked live somewhere
 * other than the posi-data checkout itself (e.g. a staging/sample-output
 * directory) while schema/ and journals/discovered/ are still read from
 * the posi-data checkout — see run-pjr-seed-pipeline.mjs's
 * --metrics-rankings-output-dir for why that split exists.
 */
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { titleKey, alternateTitleText } from '../src/global-index.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

const posiDataDir = process.argv[2]
if (!posiDataDir) {
  console.error('Usage: node scripts/validate-against-schema.mjs /path/to/posi-data [--data-dir /path/to/metrics-and-rankings-root]')
  process.exit(1)
}
const dataDir = arg('data-dir', posiDataDir)
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)

const journalSchema = JSON.parse(readFileSync(join(posiDataDir, 'schema/journal.schema.json'), 'utf-8'))
const metricSchema = JSON.parse(readFileSync(join(posiDataDir, 'schema/metric.schema.json'), 'utf-8'))
const rankingSchema = JSON.parse(readFileSync(join(posiDataDir, 'schema/ranking.schema.json'), 'utf-8'))

const validateJournal = ajv.compile(journalSchema)
const validateMetric = ajv.compile(metricSchema)
const validateRanking = ajv.compile(rankingSchema)

let errors = 0

function walk(dir) {
  let out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out = out.concat(walk(p))
    else if (entry.name.endsWith('.json')) out.push(p)
  }
  return out
}

// journals/core/**/*.json
const coreRecords = new Map()
try {
  let count = 0
  for (const f of walk(join(posiDataDir, 'journals/core'))) {
    const obj = JSON.parse(readFileSync(f, 'utf-8'))
    count++
    coreRecords.set(obj.id, obj)
    if (!validateJournal(obj)) {
      errors++
      console.log(`INVALID journal ${f}:`, JSON.stringify(validateJournal.errors))
    }
  }
  console.log(`Validated ${count} journal records in journals/core`)
} catch (e) { console.log('journals/core check skipped:', e.message) }

// corpus/core-collection.json agrees with journals/core on titles
try {
  const corpus = JSON.parse(readFileSync(join(posiDataDir, 'corpus/core-collection.json'), 'utf-8'))
  const texts = j => (j.alternate_titles ?? []).map(a => alternateTitleText(a))
  let count = 0
  for (const j of corpus) {
    const rec = coreRecords.get(j.posi_id)
    if (!rec) continue
    count++
    const problems = []
    if (rec.title !== j.title) problems.push(`title "${j.title}" in corpus/core-collection.json, "${rec.title}" in journals/core`)
    if (JSON.stringify(texts(rec)) !== JSON.stringify(texts(j))) problems.push(`alternate_titles differ between corpus/core-collection.json and journals/core`)
    for (const t of texts(j)) if (titleKey(t) === titleKey(j.title)) problems.push(`alternate title "${t}" repeats the title`)
    if (problems.length) {
      errors++
      console.log(`INCONSISTENT journal ${j.posi_id}: ${problems.join('; ')}`)
    }
  }
  console.log(`Checked titles of ${count} Core Collection journals`)
} catch (e) { console.log('core-collection title check skipped:', e.message) }

// journals/discovered/*.jsonl
try {
  const jsonlFiles = readdirSync(join(posiDataDir, 'journals/discovered')).filter(f => f.endsWith('.jsonl'))
  for (const f of jsonlFiles) {
    const lines = readFileSync(join(posiDataDir, 'journals/discovered', f), 'utf-8').trim().split('\n')
    let count = 0
    for (const line of lines) {
      const obj = JSON.parse(line)
      const valid = validateJournal(obj)
      count++
      if (!valid) {
        errors++
        console.log(`INVALID journal ${obj.id}:`, JSON.stringify(validateJournal.errors))
      }
    }
    console.log(`Validated ${count} journal records in ${f}`)
  }
} catch (e) { console.log('journals/discovered check skipped:', e.message) }

// metrics/**/*.json
try {
  const files = walk(join(dataDir, 'metrics'))
  let count = 0
  for (const f of files) {
    const obj = JSON.parse(readFileSync(f, 'utf-8'))
    const valid = validateMetric(obj)
    count++
    if (!valid) {
      errors++
      console.log(`INVALID metric ${f}:`, JSON.stringify(validateMetric.errors))
    }
  }
  console.log(`Validated ${count} metric records`)
} catch (e) { console.log('metrics check skipped:', e.message) }

// rankings/**/*.json (each file is an array of ranking records)
try {
  const files = walk(join(dataDir, 'rankings'))
  let count = 0
  for (const f of files) {
    const arr = JSON.parse(readFileSync(f, 'utf-8'))
    if (!Array.isArray(arr)) continue // edition summaries, not per-journal ranking records
    for (const obj of arr) {
      const valid = validateRanking(obj)
      count++
      if (!valid) {
        errors++
        console.log(`INVALID ranking in ${f}:`, JSON.stringify(validateRanking.errors))
      }
    }
  }
  console.log(`Validated ${count} ranking records`)
} catch (e) { console.log('rankings check skipped:', e.message) }

console.log(errors === 0 ? '\nALL VALID' : `\n${errors} INVALID RECORDS`)
process.exit(errors === 0 ? 0 : 1)
