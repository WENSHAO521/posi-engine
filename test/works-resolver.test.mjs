import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  crossrefDateToIso, normalizeCrossrefWork, selectArticleSample,
  deriveInfrastructureItemStatuses, computePublicationWindowStats,
  deriveDepositTimeliness, FREQUENCY_WINDOW_MONTHS, CONTINUITY_WINDOW_MONTHS,
} from '../src/works-resolver.mjs'
import { INFRASTRUCTURE_ITEMS, scoreOutputSignals, scoreReachConcentration, resolveAuthorIdentity } from '../src/ajr-early-stage.mjs'

const REAL_CROSSREF_WORK = {
  issue: '1', volume: '1',
  license: [{ URL: 'https://creativecommons.org/licenses/by/4.0' }],
  abstract: '<jats:p>Some abstract text.</jats:p>',
  DOI: '10.63802/afs.v1.i1.79',
  type: 'journal-article',
  title: ['A Real Article Title'],
  author: [{ ORCID: 'https://orcid.org/0009-0004-4754-6534', given: 'Zekai', family: 'Yu', affiliation: [] }],
  'container-title': ['AI & Future Society'],
  deposited: { 'date-parts': [[2026, 2, 11]] },
  'references-count': 4,
  published: { 'date-parts': [[2025, 9, 22]] },
}

test('crossrefDateToIso: full date-parts', () => {
  assert.equal(crossrefDateToIso({ 'date-parts': [[2025, 9, 22]] }), '2025-09-22')
})

test('crossrefDateToIso: year-only date-parts pads month/day to 01', () => {
  assert.equal(crossrefDateToIso({ 'date-parts': [[2025]] }), '2025-01-01')
})

test('crossrefDateToIso: missing/empty -> null, never throws', () => {
  assert.equal(crossrefDateToIso(undefined), null)
  assert.equal(crossrefDateToIso({}), null)
  assert.equal(crossrefDateToIso({ 'date-parts': [[]] }), null)
})

test('normalizeCrossrefWork: real Crossref record shape (captured live against Core Collection) normalizes correctly', () => {
  const a = normalizeCrossrefWork(REAL_CROSSREF_WORK)
  assert.equal(a.doi, '10.63802/afs.v1.i1.79')
  assert.equal(a.title, 'A Real Article Title')
  assert.equal(a.hasAbstract, true)
  assert.equal(a.referenceCount, 4)
  assert.equal(a.hasLicense, true)
  assert.equal(a.hasArchive, false)
  assert.equal(a.documentType, 'journal-article')
  assert.equal(a.publishedDate, '2025-09-22')
  assert.equal(a.depositDate, '2026-02-11')
  assert.equal(a.issueOrPeriod, 'v1i1')
  assert.equal(a.containerTitle, 'AI & Future Society')
  assert.equal(a.authors.length, 1)
  assert.equal(a.authors[0].orcid, '0009-0004-4754-6534')
  assert.equal(a.authors[0].given_name, 'Zekai')
  assert.equal(a.authors[0].family_name, 'Yu')
})

test('normalizeCrossrefWork: no volume/issue falls back to a calendar-quarter period', () => {
  const a = normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, volume: undefined, issue: undefined })
  assert.equal(a.issueOrPeriod, '2025-Q3')
})

test('normalizeCrossrefWork: missing abstract/license/references -> honest false/0, never guessed true', () => {
  const a = normalizeCrossrefWork({ DOI: '10.1/x', title: ['T'], author: [], published: { 'date-parts': [[2025, 1, 1]] } })
  assert.equal(a.hasAbstract, false)
  assert.equal(a.hasLicense, false)
  assert.equal(a.referenceCount, 0)
  assert.equal(a.hasArchive, false)
})

test('normalizeCrossrefWork output feeds scoreOutputSignals()/scoreReachConcentration() without shape errors (real contract check)', () => {
  const articles = Array.from({ length: 12 }, (_, i) => normalizeCrossrefWork({
    ...REAL_CROSSREF_WORK, DOI: `10.1/${i}`, title: [`Title ${i}`], issue: String(i % 3),
  }))
  const output = scoreOutputSignals(articles)
  const reach = scoreReachConcentration(articles)
  assert.equal(typeof output.score, 'number')
  assert.equal(typeof reach.score, 'number')
})

test('normalizeCrossrefWork authors resolve through resolveAuthorIdentity() via ORCID (AJR-E-1.1 bug-fix contract)', () => {
  const a = normalizeCrossrefWork(REAL_CROSSREF_WORK)
  assert.equal(resolveAuthorIdentity(a.authors[0]), 'orcid:0009-0004-4754-6534')
})

test('normalizeCrossrefWork authors with no ORCID but full given+family still resolve by name', () => {
  const a = normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, author: [{ given: 'Jane', family: 'Doe', affiliation: [] }] })
  assert.equal(resolveAuthorIdentity(a.authors[0]), 'name:jane doe')
})

test('selectArticleSample: spreads across distinct issueOrPeriod groups (round-robin), not a flat most-recent slice', () => {
  const groupA = Array.from({ length: 10 }, (_, i) => normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, DOI: `a${i}`, issue: '1' }))
  const groupB = Array.from({ length: 10 }, (_, i) => normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, DOI: `b${i}`, issue: '2' }))
  const sample = selectArticleSample([...groupA, ...groupB], { target: 10 })
  const periods = new Set(sample.map(a => a.issueOrPeriod))
  assert.equal(sample.length, 10)
  assert.equal(periods.size, 2, 'sample must span both groups, not just the first 10 from group A')
})

test('selectArticleSample: fewer articles than target returns everything available, no padding/fabrication', () => {
  const articles = Array.from({ length: 4 }, (_, i) => normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, DOI: `x${i}` }))
  const sample = selectArticleSample(articles, { target: 30 })
  assert.equal(sample.length, 4)
})

test('deriveInfrastructureItemStatuses: every returned key matches an INFRASTRUCTURE_ITEMS id exactly (contract test)', () => {
  const sample = [normalizeCrossrefWork(REAL_CROSSREF_WORK)]
  const statuses = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: null })
  const returnedIds = Object.keys(statuses).sort()
  const expectedIds = INFRASTRUCTURE_ITEMS.map(i => i.id).sort()
  assert.deepEqual(returnedIds, expectedIds)
})

test('deriveInfrastructureItemStatuses: empty sample -> unknown across the board, never a penalized not_met', () => {
  const statuses = deriveInfrastructureItemStatuses({ sample: [], doiChecks: [], oaiPmhCheck: null })
  assert.equal(statuses.crossref_metadata_completeness, 'unknown')
  assert.equal(statuses.abstract_reference_license_metadata, 'unknown')
  assert.equal(statuses.structured_author_affiliation_identifiers, 'unknown')
  assert.equal(statuses.doi_resolution_reliability, 'unknown')
  assert.equal(statuses.digital_preservation_archiving, 'unknown')
})

test('deriveInfrastructureItemStatuses: high-completeness real-shaped sample -> met on completeness/abstract-ref-license/structured-authors', () => {
  const sample = Array.from({ length: 5 }, (_, i) => normalizeCrossrefWork({ ...REAL_CROSSREF_WORK, DOI: `10.1/${i}` }))
  const statuses = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: null })
  assert.equal(statuses.crossref_metadata_completeness, 'met')
  assert.equal(statuses.abstract_reference_license_metadata, 'met')
  assert.equal(statuses.structured_author_affiliation_identifiers, 'met')
})

test('deriveInfrastructureItemStatuses: doi_resolution_reliability reflects real resolution ratio', () => {
  const sample = [normalizeCrossrefWork(REAL_CROSSREF_WORK)]
  const mostlyResolved = deriveInfrastructureItemStatuses({
    sample, doiChecks: [
      { doi: 'a', resolved: true, http_status: 302 }, { doi: 'b', resolved: true, http_status: 302 },
      { doi: 'c', resolved: true, http_status: 302 }, { doi: 'd', resolved: true, http_status: 302 },
      { doi: 'e', resolved: false, http_status: 404 },
    ],
    oaiPmhCheck: null,
  })
  assert.equal(mostlyResolved.doi_resolution_reliability, 'met')
  const mostlyBroken = deriveInfrastructureItemStatuses({
    sample, doiChecks: [{ doi: 'a', resolved: false, http_status: 404 }, { doi: 'b', resolved: false, http_status: 404 }],
    oaiPmhCheck: null,
  })
  assert.equal(mostlyBroken.doi_resolution_reliability, 'not_met')
})

test('deriveInfrastructureItemStatuses: oai_pmh -- no check attempted (no oai_base_url) is unknown, never not_met', () => {
  const sample = [normalizeCrossrefWork(REAL_CROSSREF_WORK)]
  const statuses = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: { attempted: false } })
  assert.equal(statuses.oai_pmh_schema_org_machine_readable, 'unknown')
})

test('deriveInfrastructureItemStatuses: oai_pmh -- real check ok:true -> met, ok:false with a real response -> not_met, network failure -> unknown', () => {
  const sample = [normalizeCrossrefWork(REAL_CROSSREF_WORK)]
  const met = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: { attempted: true, ok: true, http_status: 200 } })
  assert.equal(met.oai_pmh_schema_org_machine_readable, 'met')
  const notMet = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: { attempted: true, ok: false, http_status: 200 } })
  assert.equal(notMet.oai_pmh_schema_org_machine_readable, 'not_met')
  const unknown = deriveInfrastructureItemStatuses({ sample, doiChecks: [], oaiPmhCheck: { attempted: true, ok: false, http_status: null } })
  assert.equal(unknown.oai_pmh_schema_org_machine_readable, 'unknown')
})

test('deriveInfrastructureItemStatuses: digital_preservation_archiving is met only when a real archive entry exists', () => {
  const withArchive = [{ ...normalizeCrossrefWork(REAL_CROSSREF_WORK), hasArchive: true }]
  const withoutArchive = [normalizeCrossrefWork(REAL_CROSSREF_WORK)]
  assert.equal(deriveInfrastructureItemStatuses({ sample: withArchive, doiChecks: [], oaiPmhCheck: null }).digital_preservation_archiving, 'met')
  assert.equal(deriveInfrastructureItemStatuses({ sample: withoutArchive, doiChecks: [], oaiPmhCheck: null }).digital_preservation_archiving, 'not_met')
})

test('computePublicationWindowStats: Monthly frequency computes real expected/met windows', () => {
  const dates = ['2025-01-15', '2025-02-10', '2025-04-05'] // months 0, 1, 3 since launch (2 missed of 6)
  const stats = computePublicationWindowStats(dates, {
    frequency: 'Monthly', firstPublicationDate: '2025-01-01', ratingDate: '2025-07-01', totalArticleCount: 3,
  })
  assert.equal(stats.cadence.expectedWindows, 6)
  assert.equal(stats.cadence.metWindows, 3)
})

test('computePublicationWindowStats: Continuous/Irregular (non-periodic) frequency -> cadence not computable (0,0), never a failing 0-ratio score', () => {
  const stats = computePublicationWindowStats(['2025-01-01'], {
    frequency: 'Continuous', firstPublicationDate: '2025-01-01', ratingDate: '2025-07-01', totalArticleCount: 1,
  })
  assert.deepEqual(stats.cadence, { expectedWindows: 0, metWindows: 0 })
})

test('computePublicationWindowStats: unrecognized/null frequency also yields non-computable cadence', () => {
  const stats = computePublicationWindowStats(['2025-01-01'], { frequency: null, firstPublicationDate: '2025-01-01', ratingDate: '2025-07-01' })
  assert.deepEqual(stats.cadence, { expectedWindows: 0, metWindows: 0 })
})

test('computePublicationWindowStats: continuity uses fixed quarterly windows regardless of stated frequency', () => {
  const dates = ['2025-01-01', '2025-08-01'] // month 0 and month 7 -> quarters 0 and 2 of 3 (9 months / 3)
  const stats = computePublicationWindowStats(dates, {
    frequency: 'Continuous', firstPublicationDate: '2025-01-01', ratingDate: '2025-10-01',
  })
  assert.equal(stats.continuity.totalWindows, 3)
  assert.equal(stats.continuity.activeWindows, 2)
})

test('computePublicationWindowStats: no firstPublicationDate -> both cadence and continuity non-computable', () => {
  const stats = computePublicationWindowStats(['2025-01-01'], { frequency: 'Monthly', firstPublicationDate: null, ratingDate: '2025-07-01' })
  assert.deepEqual(stats.cadence, { expectedWindows: 0, metWindows: 0 })
  assert.deepEqual(stats.continuity, { totalWindows: 0, activeWindows: 0 })
})

test('FREQUENCY_WINDOW_MONTHS deliberately excludes Continuous and Irregular', () => {
  assert.equal(FREQUENCY_WINDOW_MONTHS.Continuous, undefined)
  assert.equal(FREQUENCY_WINDOW_MONTHS.Irregular, undefined)
  assert.equal(FREQUENCY_WINDOW_MONTHS.Monthly, 1)
  assert.equal(FREQUENCY_WINDOW_MONTHS.Quarterly, 3)
})

test('CONTINUITY_WINDOW_MONTHS is a fixed 3-month window', () => {
  assert.equal(CONTINUITY_WINDOW_MONTHS, 3)
})

test('deriveDepositTimeliness: median deposit gap <=90 days -> met', () => {
  const sample = [
    { publishedDate: '2025-01-01', depositDate: '2025-01-10' },
    { publishedDate: '2025-02-01', depositDate: '2025-02-20' },
  ]
  assert.equal(deriveDepositTimeliness(sample), 'met')
})

test('deriveDepositTimeliness: median deposit gap >90 days -> not_met', () => {
  const sample = [
    { publishedDate: '2025-01-01', depositDate: '2025-06-01' },
    { publishedDate: '2025-02-01', depositDate: '2025-07-01' },
  ]
  assert.equal(deriveDepositTimeliness(sample), 'not_met')
})

test('deriveDepositTimeliness: no usable pairs -> unknown, never a guessed default', () => {
  assert.equal(deriveDepositTimeliness([]), 'unknown')
  assert.equal(deriveDepositTimeliness([{ publishedDate: null, depositDate: null }]), 'unknown')
})
