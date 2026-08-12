import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeMqs, computeIrs, computeCvi } from '../src/diagnostics.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

test('computeMqs is always out of 100, not sometimes /25', () => {
  const items = [{ id: 'a', weight: 25, met: true }]
  assert.equal(computeMqs(items), 100, 'a single fully-met item, regardless of its own point weight, must normalize to /100')
})

test('computeMqs: partial completion scales correctly', () => {
  const items = [{ id: 'a', weight: 50, met: true }, { id: 'b', weight: 50, met: false }]
  assert.equal(computeMqs(items), 50)
})

test('computeMqs: no applicable items returns 0, not NaN or a crash', () => {
  assert.equal(computeMqs([]), 0)
  assert.equal(computeMqs([{ id: 'a', weight: 0, met: true }]), 0)
})

test('computeIrs: all seven signals met scores 100', () => {
  const signals = { sitemap: true, robots: true, oaiPmh: true, schemaOrg: true, googleScholarMetadata: true, doiResolution: true, stablePages: true }
  assert.equal(computeIrs(signals), 100)
})

test('computeIrs: no signals scores 0', () => {
  assert.equal(computeIrs({}), 0)
})

test('computeIrs: partial signals score proportionally (equal-weighted, flagged judgment call)', () => {
  const half = computeIrs({ sitemap: true, robots: true, oaiPmh: true, schemaOrg: false, googleScholarMetadata: false, doiResolution: false, stablePages: false })
  assert.ok(half > 0 && half < 100)
  assert.equal(Math.round(half), 43) // 3/7 * 100 ≈ 42.86 → rounds to 43
})

test('computeCvi: full infrastructure visibility scores 100', () => {
  const signals = { crossrefCitedByPresent: true, openAlexPresent: true, openCitationsPresent: true, referenceDepositRate: 1, citationDataAttributionPresent: true }
  assert.equal(computeCvi(signals), 100)
})

test('computeCvi: zero signals scores 0', () => {
  assert.equal(computeCvi({}), 0)
})

test('computeCvi has no citation-count/PCI input at all — infrastructure visibility, not impact', () => {
  assert.equal(computeCvi.length, 1, 'the only parameter is the infrastructure-signal object')
  const src = readFileSync(join(SRC_DIR, 'diagnostics.mjs'), 'utf-8')
  assert.ok(!/citation_count|\bpci\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'diagnostics.mjs source (excluding comments) must not reference citation_count or pci anywhere')
})

test('diagnostics.mjs is never imported by any scoring module (structural boundary check)', () => {
  const scoringModules = ['ajr-early-stage.mjs', 'ajr-mature.mjs', 'quartile-tracks.mjs', 'ranking.mjs', 'pci.mjs']
  for (const file of scoringModules) {
    const src = readFileSync(join(SRC_DIR, file), 'utf-8')
    assert.ok(!src.includes('diagnostics.mjs'), `${file} must not import diagnostics.mjs — MQS/IRS/CVI are diagnostic-only and must never blend into a score`)
  }
})

test('diagnostics.mjs does not itself import any scoring module (checked via actual import statements, not doc-comment mentions)', () => {
  const src = readFileSync(join(SRC_DIR, 'diagnostics.mjs'), 'utf-8')
  const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l))
  for (const file of ['ajr-early-stage.mjs', 'ajr-mature.mjs', 'quartile-tracks.mjs', 'ranking.mjs']) {
    assert.ok(!importLines.some(l => l.includes(file)), `diagnostics.mjs must not have an import statement for ${file}`)
  }
})
