import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataciteToCrossrefItem, dataciteIssnQuery, fetchAllDataciteWorks } from '../src/works-fetch.mjs'
import { normalizeCrossrefWork } from '../src/works-resolver.mjs'
import { normalizeCrossrefWorkForPcs } from '../src/pcs-resolver.mjs'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

// Shape of a real Zenodo-hosted journal record in DataCite (ISSN 2058-5519, checked 2026-10-26).
const zenodoArticle = {
  doi: '10.5281/zenodo.20315849',
  titles: [{ title: 'The role of vaccination in preventing global infectious diseases' }],
  creators: [
    { name: 'Karimova, Dilnoza', givenName: 'Dilnoza', familyName: 'Karimova', nameType: 'Personal',
      nameIdentifiers: [{ nameIdentifier: 'https://orcid.org/0000-0002-1825-0097', nameIdentifierScheme: 'ORCID' }],
      affiliation: [{ name: 'Tashkent Medical Academy' }] },
    { name: 'Some Lab', nameType: 'Organizational' },
  ],
  descriptions: [{ description: 'Vaccination reduces ...', descriptionType: 'Abstract' }],
  rightsList: [{ rights: 'Creative Commons Attribution 4.0 International', rightsUri: 'https://creativecommons.org/licenses/by/4.0/legalcode' }],
  types: { resourceTypeGeneral: 'Dataset' },
  dates: [{ date: '2026-05-20', dateType: 'Issued' }],
  publicationYear: 2026,
  registered: '2026-05-20T20:18:37Z',
  citationCount: 2,
  referenceCount: 0,
  container: {},
}

test('a DataCite record reads like a Crossref item to both resolvers', () => {
  const item = dataciteToCrossrefItem(zenodoArticle)
  const w = normalizeCrossrefWork(item)
  assert.equal(w.doi, '10.5281/zenodo.20315849')
  assert.equal(w.documentType, 'journal-article') // Zenodo journals type articles as Dataset
  assert.equal(w.publishedDate, '2026-05-20')
  assert.equal(w.depositDate, '2026-05-20')
  assert.equal(w.hasAbstract, true)
  assert.equal(w.hasLicense, true)
  assert.equal(w.hasArchive, null) // DataCite has no archive field: unknown
  assert.deepEqual(w.authors, [{ affiliation: 'Tashkent Medical Academy', orcid: '0000-0002-1825-0097', given_name: 'Dilnoza', family_name: 'Karimova' }])
  const p = normalizeCrossrefWorkForPcs(item)
  assert.equal(p.is_referenced_by_count, 2)
  assert.equal(p.published_year, 2026)
  assert.equal(item._source, 'datacite')
})

test('a year-only DataCite date and a non-article type carry through', () => {
  const item = dataciteToCrossrefItem({ doi: '10.1/x', types: { resourceTypeGeneral: 'Preprint' }, publicationYear: 2024 })
  assert.deepEqual(item.published, { 'date-parts': [[2024]] })
  assert.equal(item.type, 'posted-content')
})

test('the ISSN query leaves out Zenodo concept DOIs and can bound the years', () => {
  const q = dataciteIssnQuery('2058-5519', { fromYear: 2022, untilYear: 2025 })
  assert.match(q, /relatedIdentifiers\.relatedIdentifier:"2058-5519" OR container\.identifier:"2058-5519"/)
  assert.match(q, /NOT relatedIdentifiers\.relationType:HasVersion/)
  assert.match(q, /publicationYear:\[2022 TO 2025\]/)
})

test('fetchAllDataciteWorks pages by number, newest first, until the total', async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    const n = Number(new URL(url).searchParams.get('page[number]'))
    const data = n <= 2 ? [{ attributes: { ...zenodoArticle, doi: `10.5281/zenodo.${n}a` } }, { attributes: { ...zenodoArticle, doi: `10.5281/zenodo.${n}b` } }] : []
    return jsonResponse({ meta: { total: 3 }, data: n === 2 ? data.slice(0, 1) : data })
  }
  const r = await fetchAllDataciteWorks('2058-5519', { fetchImpl, rows: 2 })
  assert.equal(r.status, 200)
  assert.equal(r.totalResults, 3)
  assert.equal(r.items.length, 3)
  assert.equal(urls.length, 2)
  assert.equal(new URL(urls[0]).searchParams.get('sort'), '-created')
})

test('fetchAllDataciteWorks: nothing under the ISSN is a 404, a server error is reported', async () => {
  const empty = await fetchAllDataciteWorks('0000-0000', { fetchImpl: async () => jsonResponse({ meta: { total: 0 }, data: [] }) })
  assert.equal(empty.status, 404)
  assert.equal(empty.items.length, 0)
  const failed = await fetchAllDataciteWorks('0000-0000', { fetchImpl: async () => jsonResponse({}, 400), maxAttempts: 1 })
  assert.equal(failed.status, 400)
})

test('a sample read from DataCite leaves digital preservation unknown, not unmet', async () => {
  const { deriveInfrastructureItemStatuses } = await import('../src/works-resolver.mjs')
  const sample = [normalizeCrossrefWork(dataciteToCrossrefItem(zenodoArticle))]
  assert.equal(deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: null }).digital_preservation_archiving, 'unknown')
})
