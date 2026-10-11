#!/usr/bin/env node
/**
 * normalize-countries.mjs
 *
 * Rewrites country / registration_country values stored as ISO or MARC codes
 * (KR, IO, TU, CAU, XXK ...) as English country names. See lib/country-codes.mjs
 * for why: the site reads two-letter values as ISO, which misplaces MARC codes.
 * Codes that cannot be placed with confidence are left as they are and listed.
 * Names in another common form ("Iran, Islamic Republic of", "Türkiye") are
 * rewritten to the name the data uses ("Iran", "Turkey").
 *
 * Usage:
 *   node scripts/normalize-countries.mjs            # dry run
 *   node scripts/normalize-countries.mjs --write    # apply
 */

import { loadDiscovered, saveDiscovered, DISCOVERED_FILE } from './lib/discovered-store.mjs'
import { normalizeCountryCode, canonicalCountryName } from './lib/country-codes.mjs'

const WRITE = process.argv.includes('--write')

const records = loadDiscovered()
const changes = new Map()   // "CODE -> Name" -> count
const unresolved = new Map()
let touched = 0

for (const r of records) {
  let changed = false
  for (const field of ['country', 'registration_country']) {
    const before = r[field]
    const code = normalizeCountryCode(before)
    const after = code == null ? null : canonicalCountryName(code)
    if (after === before) continue
    if (after == null) {
      unresolved.set(before, (unresolved.get(before) ?? 0) + 1)
      continue
    }
    r[field] = after
    changed = true
    const k = `${before} -> ${after}`
    changes.set(k, (changes.get(k) ?? 0) + 1)
  }
  if (changed) touched++
}

for (const [k, n] of [...changes].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(48)} ${n}`)
console.log(`\nRecords changed: ${touched}`)
if (unresolved.size) console.log(`Left as is (ambiguous): ${[...unresolved].map(([c, n]) => `${c}:${n}`).join(' ')}`)

if (WRITE) {
  saveDiscovered(records)
  console.log(`Written to ${DISCOVERED_FILE}`)
} else {
  console.log('Dry run — pass --write to apply.')
}
