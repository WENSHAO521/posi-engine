#!/usr/bin/env node
/**
 * calc-discovered-mqs.mjs
 * Post-processes src/lib/discovered-journals.json to set metadata_quality_score per journal
 * based on field completeness rather than the hardcoded 30.
 *
 * Usage: node scripts/calc-discovered-mqs.mjs
 */

import { loadDiscovered, saveDiscovered } from './lib/discovered-store.mjs'


// MQS formula for discovered journals — scores field completeness only.
// DOAJ listing is not a completeness signal and no longer contributes points
// (previously an unconditional +12 for every discovered journal, regardless of
// whether it was actually DOAJ-listed).
// Max = 20 + 20 + 10 + 12 + 12 + 12 + 8 + 6 = 100
function calcMqs({ eissn, pissn, pub, country, web, arts, freq, lic }) {
  let s = 20                 // base
  if (eissn)   s += 20      // has electronic ISSN (primary identifier)
  if (pissn)   s += 10      // has print ISSN
  if (pub)     s += 12      // publisher name present
  if (country) s += 12      // registration country known
  if (web)     s += 12      // homepage URL present
  if (arts > 0) s += 8      // has tracked publications
  if (freq)    s += 6       // publication frequency known
  if (lic)     s += 6       // specific license (not generic 'Open Access')
  return Math.min(s, 100)
}

function fieldsOf(r) {
  const has = v => typeof v === 'string' && v.trim().length > 0
  return {
    eissn:   has(r.issn_online),
    pissn:   has(r.issn_print),
    pub:     has(r.publisher),
    // registration_country is more reliable than country for discovered journals
    country: has(r.registration_country) || has(r.country),
    web:     has(r.website_url),
    arts:    r.article_count ?? 0,
    freq:    has(r.frequency),
    lic:     has(r.license) && r.license !== 'Open Access',
  }
}

console.log('Reading discovered-journals.json…')
const records = loadDiscovered()
let patched = 0
for (const r of records) {
  const mqs = calcMqs(fieldsOf(r))
  if (r.metadata_quality_score !== mqs) { r.metadata_quality_score = mqs; patched++ }
}
saveDiscovered(records)
console.log(`Done — patched metadata_quality_score for ${patched.toLocaleString()} journals`)

// Show score distribution
const dist = {}
for (const r of records) { const k = String(r.metadata_quality_score); dist[k] = (dist[k] ?? 0) + 1 }
console.log('Score distribution:')
Object.entries(dist).sort(([a], [b]) => Number(b) - Number(a)).forEach(([s, c]) =>
  console.log(`  ${s.padStart(3)}: ${c.toLocaleString()} journals`)
)
