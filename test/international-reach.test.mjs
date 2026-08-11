import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeAuthorCountryFields, computeCitingCountryFields, buildInternationalReachBlock } from '../src/international-reach.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

test('computeAuthorCountryFields: matches PJR-SPEC.md § 6\'s field set exactly', () => {
  const authors = [
    { country: 'US' }, { country: 'US' }, { country: 'US' }, { country: 'GB' }, { country: 'FR' },
  ]
  const result = computeAuthorCountryFields(authors, 'US')
  assert.equal(result.author_countries, 3)
  assert.equal(result.international_collaboration_share, 0.4, '2 of 5 authors are non-US')
  assert.equal(result.largest_author_country_share, 0.6, '3 of 5 authors are US, the largest single country')
})

test('computeAuthorCountryFields: no country data returns nulls for the share fields, not zero (uninterpreted-as-100%-regional)', () => {
  const result = computeAuthorCountryFields([], 'US')
  assert.equal(result.author_countries, 0)
  assert.equal(result.international_collaboration_share, null)
  assert.equal(result.largest_author_country_share, null)
})

test('a purely regional journal (100% single-country authors) is described accurately, not penalized — this module has no score field at all', () => {
  const regional = computeAuthorCountryFields([{ country: 'BR' }, { country: 'BR' }, { country: 'BR' }], 'BR')
  assert.equal(regional.international_collaboration_share, 0)
  assert.equal(regional.largest_author_country_share, 1)
  assert.ok(!('score' in regional) && !('penalty' in regional) && !('flag' in regional))
})

test('computeCitingCountryFields mirrors the author-side logic for citations', () => {
  const citations = [{ citing_country: 'US' }, { citing_country: 'DE' }, { citing_country: 'DE' }]
  const result = computeCitingCountryFields(citations, 'US')
  assert.equal(result.citing_countries, 2)
  assert.equal(result.international_citation_share, 0.6667, 'rounded to 4 decimal places')
})

test('buildInternationalReachBlock matches schema/metric.schema.json\'s `international` shape exactly', () => {
  const block = buildInternationalReachBlock({
    authors: [{ country: 'US' }, { country: 'CA' }],
    citations: [{ citing_country: 'US' }],
    homeCountry: 'US',
  })
  assert.deepEqual(Object.keys(block).sort(), [
    'author_countries', 'citing_countries', 'international_citation_share',
    'international_collaboration_share', 'largest_author_country_share',
  ].sort())
})

test('international-reach.mjs is never imported by any scoring module (structural boundary check — descriptive only, never scored)', () => {
  const scoringModules = ['ajr-early-stage.mjs', 'ajr-mature.mjs', 'quartile-tracks.mjs', 'ranking.mjs', 'pci.mjs']
  for (const file of scoringModules) {
    const src = readFileSync(join(SRC_DIR, file), 'utf-8')
    assert.ok(!src.includes('international-reach.mjs'), `${file} must not import international-reach.mjs`)
  }
})
