// Read/write access to the Discovered journal records.
//
// The records live in src/lib/discovered-journals.json: a JSON array written
// one record per line, so a sync that touches ten journals produces a ten-line
// diff. Every script that changes Discovered records goes through load() and
// save() here instead of patching source text.

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// The site-shaped records the scripts work on. In the directory-sync workflow this is a file composed from
// posi-data (export-site-records.mjs); POSI_DISCOVERED_FILE says where.
export const DISCOVERED_FILE = process.env.POSI_DISCOVERED_FILE
  ?? join(dirname(fileURLToPath(import.meta.url)), '../../../work/discovered-journals.json')

/** Date on the automated PQF pre-screens made before evaluations were dated individually. */
export const AUTO_PQF_EVALUATED_AT = '2026-06-22'
export const AUTO_PQF_VERSION = 'PQF v1.0-auto'

export function gradeFor(total) {
  return total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B+' : total >= 60 ? 'B' : total >= 50 ? 'C' : total >= 40 ? 'D' : 'E'
}

/** Same result as the former autopqf(jtf, mqf, egf, tdf, cvf, rif) helper in discovered-journals.ts. */
/** evaluatedAt is the date the evidence was collected (YYYY-MM-DD); it decides which scores are refreshed first. */
export function autoPqf({ jtf, mqf, egf, tdf, cvf, rif }, evaluatedAt = new Date().toISOString().slice(0, 10)) {
  const total = jtf + mqf + egf + tdf + cvf + rif
  return { total, grade: gradeFor(total), subfactors: { jtf, mqf, egf, tdf, cvf, rif }, evaluated_at: evaluatedAt, version: AUTO_PQF_VERSION }
}

export function loadDiscovered(file = DISCOVERED_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function serializeDiscovered(records) {
  return '[\n' + records.map(r => JSON.stringify(r)).join(',\n') + '\n]\n'
}

export function saveDiscovered(records, file = DISCOVERED_FILE) {
  writeFileSync(file, serializeDiscovered(records), 'utf8')
}

/** Every ISSN already present, for de-duplicating new discoveries. */
export function knownIssns(records) {
  const s = new Set()
  for (const r of records) {
    if (r.issn_online) s.add(r.issn_online)
    if (r.issn_print) s.add(r.issn_print)
  }
  return s
}
