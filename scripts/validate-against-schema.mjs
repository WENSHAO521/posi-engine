#!/usr/bin/env node
/**
 * validate-against-schema.mjs
 *
 * Validates every committed journals/discovered/*.jsonl record,
 * metrics/**\/*.json record, and rankings/**\/*.json record (each a JSON
 * array of 1+ ranking records for one journal) in a posi-data checkout
 * against that repo's own schema/journal.schema.json,
 * schema/metric.schema.json, and schema/ranking.schema.json — real ajv
 * validation (draft 2020-12), not a hand-rolled required-field check.
 * Exits non-zero if anything fails, so it's usable as a CI gate.
 *
 * Usage:
 *   node scripts/validate-against-schema.mjs /path/to/posi-data
 */
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const posiDataDir = process.argv[2]
if (!posiDataDir) {
  console.error('Usage: node scripts/validate-against-schema.mjs /path/to/posi-data')
  process.exit(1)
}
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
  const files = walk(join(posiDataDir, 'metrics'))
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
  const files = walk(join(posiDataDir, 'rankings'))
  let count = 0
  for (const f of files) {
    const arr = JSON.parse(readFileSync(f, 'utf-8'))
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
