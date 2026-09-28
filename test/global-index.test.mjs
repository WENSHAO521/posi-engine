import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normIssn, fromOpenAlexSource, fromCrossrefJournal, buildGlobalCorpus } from '../src/global-index.mjs'

const oaSource = (over = {}) => ({
  id: 'https://openalex.org/S1', display_name: 'Journal A', host_organization_name: 'Pub A',
  issn_l: '1234-5678', issn: ['1234-5678', '8765-4321'], country_code: 'GB', is_oa: true, is_in_doaj: true,
  apc_usd: 1000, works_count: 500,
  topics: [{ count: 400, field: { display_name: 'Mathematics' }, subfield: { display_name: 'Algebra and Number Theory' } }],
  ...over,
})

test('normIssn accepts common forms and rejects junk', () => {
  assert.equal(normIssn('12345678'), '1234-5678')
  assert.equal(normIssn('0000-000x'), '0000-000X')
  assert.equal(normIssn('1234 5678'), '1234-5678')
  assert.equal(normIssn('12-34'), null)
  assert.equal(normIssn(null), null)
})

test('OpenAlex sources are classified with the corpus PSC classifier', () => {
  const r = fromOpenAlexSource(oaSource())
  assert.equal(r.openalex_source_id, 'S1')
  assert.equal(r.psc_category, 'P1.01')
  assert.equal(r.psc_confidence, 'high')
  assert.deepEqual(r.issns, ['1234-5678', '8765-4321'])
})

test('Crossref journals merge into OpenAlex records on any shared ISSN', () => {
  const oa = [fromOpenAlexSource(oaSource())]
  const cr = [fromCrossrefJournal({ title: 'Journal A', publisher: 'Pub A', ISSN: ['8765-4321'], counts: { 'total-dois': 900 } })]
  const out = buildGlobalCorpus(oa, cr)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].sources, ['openalex', 'crossref'])
  assert.equal(out[0].crossref_total_dois, 900)
  assert.equal(out[0].posi_id, 'ISSNL-1234-5678')
})

test('Crossref-only journals are kept, unclassified, keyed by first ISSN', () => {
  const cr = [fromCrossrefJournal({ title: 'Only CR', publisher: 'P', 'issn-type': [{ type: 'electronic', value: '1111-2222' }] })]
  const out = buildGlobalCorpus([], cr)
  assert.equal(out[0].posi_id, 'ISSNL-1111-2222')
  assert.equal(out[0].psc_confidence, 'unclassified')
})

test('titles never merge records; ISSNs do', () => {
  const oa = [fromOpenAlexSource(oaSource()), fromOpenAlexSource(oaSource({ id: 'S2', issn_l: '9999-0000', issn: ['9999-0000'] }))]
  assert.equal(buildGlobalCorpus(oa, []).length, 2)
})

test('curated records keep their POSI-J id and are not duplicated', () => {
  const oa = [fromOpenAlexSource(oaSource())]
  const out = buildGlobalCorpus(oa, [], [{ posi_id: 'POSI-J-000042', issns: ['8765-4321'] }])
  assert.equal(out.length, 1)
  assert.equal(out[0].posi_id, 'POSI-J-000042')
  assert.equal(out[0].curated, true)
})

test('curated titles win over registry titles, which stay as alternate titles', () => {
  const oa = [fromOpenAlexSource(oaSource())]
  const registry = oa[0].title
  const [rec] = buildGlobalCorpus(oa, [], [{ posi_id: 'POSI-J-000042', issns: ['8765-4321'], title: 'Renamed Journal', alternate_titles: [registry.toUpperCase(), 'Old Name'] }])
  assert.equal(rec.title, 'Renamed Journal')
  assert.deepEqual(rec.alternate_titles, [registry.toUpperCase(), 'Old Name'])
  const [plain] = buildGlobalCorpus(oa, [], [{ posi_id: 'POSI-J-000042', issns: ['8765-4321'] }])
  assert.equal(plain.title, registry)
  assert.equal('alternate_titles' in plain, false)
})

test('OpenAlex journals without an ISSN are not indexed', () => {
  assert.equal(buildGlobalCorpus([fromOpenAlexSource(oaSource({ issn_l: null, issn: [] }))], []).length, 0)
})

test('Crossref journals without an ISSN are left out', () => {
  assert.equal(buildGlobalCorpus([], [fromCrossrefJournal({ title: 'No ISSN', publisher: 'P' })]).length, 0)
})

test('the ISSN-L is the ISSN the PCS ETL queries', () => {
  const src = fromOpenAlexSource(oaSource({ issn_l: '0140-6736', issn: ['0099-5355', '1474-547X', '0140-6736'] }))
  const [rec] = buildGlobalCorpus([src], [])
  assert.equal(rec.issn_online, '0140-6736')
  assert.equal(rec.issns[0], '0140-6736')
})
