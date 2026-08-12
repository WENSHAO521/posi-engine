import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldTitle, buildPosiIndex, crossCheckIssnFamily, crossCheckTitleOnlyFamily } from '../src/showjcr/match.mjs'

function posi(overrides) {
  return { id: 'POSI-J-000001', title: 'Journal of Things', issn_l: '1234-5678', issn_print: null, issn_online: '1234-5678', ...overrides }
}

test('foldTitle folds case, punctuation, and "&" so trivial variants compare equal', () => {
  assert.equal(foldTitle('Journal of Cell & Molecular Biology'), foldTitle('JOURNAL OF CELL AND MOLECULAR BIOLOGY'))
  assert.equal(foldTitle('  Journal:  of Things  '), foldTitle('Journal of Things'))
})

test('foldTitle preserves non-Latin scripts (Chinese journal names) instead of folding them to empty', () => {
  assert.equal(foldTitle('计算机学报'), '计算机学报')
  assert.notEqual(foldTitle('计算机学报'), foldTitle('软件学报'))
})

test('crossCheckIssnFamily: matching ISSN and matching title -> counted, not flagged', () => {
  const index = buildPosiIndex([posi()])
  const { titleMismatches, issnMismatches, notFound, matchedCount } = crossCheckIssnFamily(
    [{ journal: 'Journal of Things', issn: '1234-5678', eissn: null }], index, 'jcr',
  )
  assert.equal(matchedCount, 1)
  assert.deepEqual(titleMismatches, [])
  assert.deepEqual(issnMismatches, [])
  assert.deepEqual(notFound, [])
})

test('crossCheckIssnFamily: ISSN matches but title disagrees -> title_mismatch_on_issn_match', () => {
  const index = buildPosiIndex([posi({ title: 'Journl of Thngs' })]) // simulated typo in POSI
  const { titleMismatches, matchedCount } = crossCheckIssnFamily(
    [{ journal: 'Journal of Things', issn: '1234-5678', eissn: null }], index, 'jcr',
  )
  assert.equal(matchedCount, 0)
  assert.equal(titleMismatches.length, 1)
  assert.equal(titleMismatches[0].type, 'title_mismatch_on_issn_match')
  assert.equal(titleMismatches[0].posi_id, 'POSI-J-000001')
})

test('crossCheckIssnFamily: title matches an existing POSI record but no shared ISSN -> issn_mismatch_on_title_match', () => {
  const index = buildPosiIndex([posi({ issn_l: '9999-0000', issn_online: '9999-0000' })])
  const { issnMismatches, notFound } = crossCheckIssnFamily(
    [{ journal: 'Journal of Things', issn: '1234-5678', eissn: null }], index, 'jcr',
  )
  assert.equal(issnMismatches.length, 1)
  assert.equal(issnMismatches[0].type, 'issn_mismatch_on_title_match')
  assert.equal(issnMismatches[0].confidence, 'normal') // "Journal of Things" is a distinctive multi-word title
  assert.deepEqual(notFound, [])
})

test('crossCheckIssnFamily: a short/generic-title ISSN mismatch is flagged low-confidence, not treated the same as a distinctive title', () => {
  const index = buildPosiIndex([posi({ title: 'Politics', issn_l: '9999-0000', issn_online: '9999-0000' })])
  const { issnMismatches } = crossCheckIssnFamily(
    [{ journal: 'Politics', issn: '1234-5678', eissn: null }], index, 'jcr',
  )
  assert.equal(issnMismatches.length, 1)
  assert.equal(issnMismatches[0].confidence, 'low_generic_title')
})

test('crossCheckIssnFamily: neither ISSN nor title matches anything -> notFound (coverage candidate)', () => {
  const index = buildPosiIndex([posi()])
  const { notFound, titleMismatches, issnMismatches } = crossCheckIssnFamily(
    [{ journal: 'Completely Different Journal', issn: '0000-1111', eissn: null }], index, 'jcr',
  )
  assert.equal(notFound.length, 1)
  assert.deepEqual(titleMismatches, [])
  assert.deepEqual(issnMismatches, [])
})

test('crossCheckIssnFamily: matches via EISSN when ISSN itself is absent from POSI', () => {
  const index = buildPosiIndex([posi({ issn_l: null, issn_online: '5555-6666' })])
  const { matchedCount } = crossCheckIssnFamily(
    [{ journal: 'Journal of Things', issn: null, eissn: '5555-6666' }], index, 'jcr',
  )
  assert.equal(matchedCount, 1)
})

test('crossCheckTitleOnlyFamily: title-only families (CCF/CCFT/early-warning) report found vs notFound, carrying extra fields through', () => {
  const index = buildPosiIndex([posi()])
  const { found, notFound } = crossCheckTitleOnlyFamily(
    [
      { journal: 'Journal of Things', tier: 'A类', category: '推荐国际学术刊物' },
      { journal: 'Unknown Journal', tier: 'B类', category: '推荐国际学术刊物' },
    ],
    index, 'ccf',
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].posi_id, 'POSI-J-000001')
  assert.equal(found[0].tier, 'A类') // CCF's own tier field passed through untouched
  assert.equal(notFound.length, 1)
  assert.equal(notFound[0].journal, 'Unknown Journal')
})

test('buildPosiIndex indexes all three ISSN fields and the folded title', () => {
  const index = buildPosiIndex([posi({ issn_l: '1111-1111', issn_print: '2222-2222', issn_online: '3333-3333' })])
  assert.equal(index.byIssn.get('1111-1111')[0].id, 'POSI-J-000001')
  assert.equal(index.byIssn.get('2222-2222')[0].id, 'POSI-J-000001')
  assert.equal(index.byIssn.get('3333-3333')[0].id, 'POSI-J-000001')
  assert.equal(index.byTitle.get(foldTitle('Journal of Things'))[0].id, 'POSI-J-000001')
})
