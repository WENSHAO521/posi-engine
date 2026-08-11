import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveFirstPublicationDate,
  isExcludedFromFirstPublicationCandidacy,
  FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION,
} from '../src/first-publication-date.mjs'

test('publisher_verified beats crossref/openalex even if the latter are earlier-dated', () => {
  const result = resolveFirstPublicationDate([
    { source: 'crossref', date: '2019-01-01', document_type: 'research-article' },
    { source: 'publisher_verified', date: '2020-06-15', document_type: 'research-article', evidence_id: 'https://publisher.example/archive' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, '2020-06-15')
  assert.equal(result.source, 'publisher_verified')
})

test('within a tier, the earliest qualifying date wins, not the first array entry', () => {
  const result = resolveFirstPublicationDate([
    { source: 'crossref', date: '2021-05-01', document_type: 'research-article', evidence_id: '10.1/later' },
    { source: 'crossref', date: '2020-03-18', document_type: 'research-article', evidence_id: '10.1/earlier' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, '2020-03-18')
  assert.equal(result.evidence_id, '10.1/earlier')
})

test('falls through the priority chain: no publisher/crossref evidence, uses openalex', () => {
  const result = resolveFirstPublicationDate([
    { source: 'openalex', date: '2022-09-09', document_type: 'research-article' },
    { source: 'other_archive', date: '2022-01-01', document_type: 'research-article' },
  ], '2026-08-12')
  assert.equal(result.source, 'openalex')
  assert.equal(result.first_regular_publication_date, '2022-09-09')
})

test('editorial / call-for-papers / front-matter / correction / retraction-notice / announcement are excluded from candidacy', () => {
  const excludedTypes = ['editorial', 'call-for-papers', 'front-matter', 'correction', 'retraction-notice', 'announcement']
  for (const document_type of excludedTypes) {
    assert.equal(isExcludedFromFirstPublicationCandidacy({ document_type }), true, document_type)
  }
  assert.equal(isExcludedFromFirstPublicationCandidacy({ document_type: 'research-article' }), false)
})

test('an early editorial does not win over a later real research article', () => {
  const result = resolveFirstPublicationDate([
    { source: 'crossref', date: '2018-01-01', document_type: 'editorial' },
    { source: 'crossref', date: '2018-04-01', document_type: 'research-article' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, '2018-04-01')
  assert.equal(result.excluded_candidate_count, 1)
})

test('falls back to a title heuristic only when document_type is absent', () => {
  const result = resolveFirstPublicationDate([
    { source: 'other_archive', date: '2015-01-01', title: 'Editorial: launching this journal' },
    { source: 'other_archive', date: '2015-06-01', title: 'A Study of Something Real' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, '2015-06-01')
})

test('a real title starting with a word that merely resembles an excluded pattern is not falsely excluded', () => {
  // "Corrections to Colonial Land Policy" is a real article title, not a
  // correction notice — the regex requires "corrigendum"/"erratum", not
  // the plain English word "correction", specifically to avoid this.
  const result = isExcludedFromFirstPublicationCandidacy({ title: 'Corrections to Colonial Land Policy: A Reassessment' })
  assert.equal(result, false)
})

test('returns unknown (all nulls) when no candidates qualify at all', () => {
  const result = resolveFirstPublicationDate([], '2026-08-12')
  assert.equal(result.first_regular_publication_date, null)
  assert.equal(result.source, null)
  assert.equal(result.evidence_id, null)
  assert.equal(result.verified_at, '2026-08-12')
  assert.equal(result.methodology_version, FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION)
})

test('returns unknown when every candidate is excluded (all editorials/announcements)', () => {
  const result = resolveFirstPublicationDate([
    { source: 'crossref', date: '2020-01-01', document_type: 'editorial' },
    { source: 'openalex', date: '2020-02-01', document_type: 'announcement' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, null)
  assert.equal(result.excluded_candidate_count, 2)
})

test('candidates with an unrecognized source are rejected, not silently ranked last', () => {
  const result = resolveFirstPublicationDate([
    { source: 'random_blog', date: '2010-01-01', document_type: 'research-article' },
    { source: 'openalex', date: '2020-01-01', document_type: 'research-article' },
  ], '2026-08-12')
  assert.equal(result.first_regular_publication_date, '2020-01-01')
  assert.deepEqual(result.rejected_unrecognized_sources, ['random_blog'])
})

test('matches the framework worked example shape', () => {
  const result = resolveFirstPublicationDate([
    { source: 'crossref', date: '2024-03-18', document_type: 'research-article', evidence_id: '10.xxxx/xxxx' },
  ], '2026-08-12')
  assert.deepEqual(result, {
    first_regular_publication_date: '2024-03-18',
    source: 'crossref',
    evidence_id: '10.xxxx/xxxx',
    verified_at: '2026-08-12',
    methodology_version: FIRST_PUBLICATION_DATE_METHODOLOGY_VERSION,
    excluded_candidate_count: 0,
    rejected_unrecognized_sources: [],
  })
})
