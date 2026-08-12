import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManifest,
  releaseAssetFilenames,
  defaultReleaseName,
  buildShasumsFile,
  validateManifest,
} from '../src/release.mjs'

function baseParams(overrides = {}) {
  return {
    release: 'PJR-2028.1',
    metric_year: 2027,
    data_cutoff: '2027-12-31',
    released: '2028-06-15',
    psc_version: '1.0.0',
    pci_methodology_version: 'PCI-1.0',
    ranking_methodology_version: 'RANK-1.0',
    data_commit: 'a'.repeat(40),
    engine_commit: 'b'.repeat(40),
    journals: [{ id: 'POSI-J-000001' }, { id: 'POSI-J-000002' }],
    metrics: [{ journal_id: 'POSI-J-000001', status: 'active' }, { journal_id: 'POSI-J-000002', status: 'insufficient_data' }],
    categoryCodes: ['P1.01', 'P1.01', 'P5.02'],
    ...overrides,
  }
}

test('buildManifest matches the exact PJR-SPEC.md § 2 shape from the worked example', () => {
  const manifest = buildManifest(baseParams())
  assert.deepEqual(Object.keys(manifest).sort(), [
    'category_count', 'data_commit', 'data_cutoff', 'engine_commit',
    'journal_count', 'metric_eligible_journal_count',
    'metric_year', 'pci_methodology_version', 'psc_version', 'ranking_methodology_version',
    'release', 'released', 'supersedes',
  ].sort())
  assert.equal(manifest.journal_count, 2)
  assert.equal(manifest.category_count, 2, 'category_count is the distinct category count, not the raw list length')
  assert.equal(manifest.supersedes, null)
})

test('buildManifest counts metric_eligible_journal_count as active + suppressed, not insufficient_data', () => {
  const manifest = buildManifest(baseParams())
  assert.equal(manifest.metric_eligible_journal_count, 1, 'only the active-status metric counts; insufficient_data is not metric-eligible for this release')
})

test('buildManifest sets supersedes only when explicitly passed (a corrected re-issue, PJR-SPEC.md § 7)', () => {
  const manifest = buildManifest(baseParams({ supersedes: 'PJR-2028.1' , release: 'PJR-2028.2' }))
  assert.equal(manifest.supersedes, 'PJR-2028.1')
})

test('buildManifest throws on a missing required provenance field rather than silently defaulting it', () => {
  const params = baseParams()
  delete params.data_commit
  assert.throws(() => buildManifest(params), /data_commit/)
})

test('buildManifest throws if journals/metrics are not arrays', () => {
  assert.throws(() => buildManifest(baseParams({ journals: null })), /journals/)
})

test('releaseAssetFilenames substitutes the release name into every § 3 asset filename', () => {
  const files = releaseAssetFilenames('PJR-2028.1')
  assert.deepEqual(files, [
    'manifest.json',
    'SHA256SUMS',
    'posi-journals-PJR-2028.1.jsonl.gz',
    'posi-classifications-PJR-2028.1.csv.gz',
    'posi-metrics-PJR-2028.1.csv.gz',
    'posi-rankings-PJR-2028.1.csv.gz',
  ])
})

test('defaultReleaseName is metric_year + 1, revision .1', () => {
  assert.equal(defaultReleaseName(2027), 'PJR-2028.1')
})

test('buildShasumsFile matches conventional sha256sum output format', () => {
  const content = buildShasumsFile([
    { filename: 'manifest.json', sha256: 'a'.repeat(64) },
    { filename: 'SHA256SUMS', sha256: 'b'.repeat(64) },
  ])
  assert.equal(content, `${'a'.repeat(64)}  manifest.json\n${'b'.repeat(64)}  SHA256SUMS\n`)
})

test('validateManifest accepts a well-formed manifest', () => {
  const manifest = buildManifest(baseParams())
  const result = validateManifest(manifest)
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateManifest flags metric_eligible_journal_count exceeding journal_count', () => {
  const manifest = buildManifest(baseParams())
  manifest.metric_eligible_journal_count = manifest.journal_count + 1
  const result = validateManifest(manifest)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('cannot exceed')))
})

test('validateManifest flags a release name that does not match PJR-{year}.{revision}', () => {
  const manifest = buildManifest(baseParams())
  manifest.release = 'PJR-release-1'
  const result = validateManifest(manifest)
  assert.equal(result.valid, false)
})
