import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVIDENCE_CRITERIA, resolveCriterion, resolveAllCriteria } from '../src/evidence-resolver.mjs'
import { EDITORIAL_GOVERNANCE_ITEMS, RESEARCH_INTEGRITY_ITEMS } from '../src/ajr-early-stage.mjs'
import { TRANSPARENCY_ITEMS } from '../src/shared-dimensions.mjs'

const WEBSITE = 'https://j.example.com'
const editorialBoard = EVIDENCE_CRITERIA.find(c => c.id === 'editorial_board_public')
const publicationEthics = EVIDENCE_CRITERIA.find(c => c.id === 'publication_ethics_policy')

test('REVIEW-CAUGHT BUG, FIXED: every AJR-E evidence item has exactly one resolver mapping (id AND weight)', () => {
  // The original resolver's ids (aims_scope, editorial_board, ...) did not
  // match the canonical ids AJR-E's own scoring functions
  // (scoreEditorialGovernance/scoreResearchIntegrity/scoreTransparency)
  // actually key their itemStatuses lookup on -- feeding this module's
  // output straight into computeAjrE() would have silently read every
  // fully-resolved match as `unknown`, since the id just wouldn't be found.
  // This contract test fails loudly the moment the two ever drift apart
  // again, in either direction.
  const canonicalItems = [...EDITORIAL_GOVERNANCE_ITEMS, ...RESEARCH_INTEGRITY_ITEMS, ...TRANSPARENCY_ITEMS]
  for (const canonical of canonicalItems) {
    const resolverEntry = EVIDENCE_CRITERIA.find(c => c.id === canonical.id)
    assert.ok(resolverEntry, `AJR-E evidence item "${canonical.id}" has no matching EVIDENCE_CRITERIA entry`)
    assert.equal(resolverEntry.weight, canonical.weight, `"${canonical.id}" weight mismatch: AJR-E expects ${canonical.weight}, resolver has ${resolverEntry.weight}`)
  }
  // And the reverse direction: the resolver must not emit a criterion id
  // that no real AJR-E dimension actually consumes (a silent no-op item).
  for (const resolverEntry of EVIDENCE_CRITERIA) {
    assert.ok(canonicalItems.some(c => c.id === resolverEntry.id), `EVIDENCE_CRITERIA has "${resolverEntry.id}", which no AJR-E dimension item list defines`)
  }
  assert.equal(EVIDENCE_CRITERIA.length, canonicalItems.length, 'exact 1:1 coverage, no extras on either side')
})

test('resolveCriterion: content match on any fetched ok page -> met, with the matching page cited as source', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Welcome to our journal.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/editorial-board`, fetch_status: 'ok', http_status: 200, body: 'Our Editorial Board consists of...', retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(editorialBoard, pages, WEBSITE)
  assert.equal(result.status, 'met')
  assert.equal(result.source_url, `${WEBSITE}/editorial-board`)
})

test('resolveCriterion: bilingual match -- Chinese pattern is detected same as English', () => {
  const pages = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: '本刊编委会由以下专家组成', retrieved_at: '2026-08-12T00:00:00Z' }]
  const result = resolveCriterion(editorialBoard, pages, WEBSITE)
  assert.equal(result.status, 'met')
})

test('THE REVIEW-CAUGHT BUG, FIXED: homepage 200 + this criterion\'s own relevant page 403 -> blocked, NEVER not_met', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Welcome. Nothing about ethics mentioned here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'blocked', 'must be blocked, not not_met -- the relevant page was 403, not confirmed absent')
})

test('the same bug, timeout/5xx variant -> unknown, never not_met', () => {
  const pagesTimeout = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'timeout', http_status: null, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  assert.equal(resolveCriterion(publicationEthics, pagesTimeout, WEBSITE).status, 'unknown')

  const pages5xx = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'server_error', http_status: 503, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  assert.equal(resolveCriterion(publicationEthics, pages5xx, WEBSITE).status, 'unknown')
})

test('an IRRELEVANT page failing does not block an unrelated criterion -- 403 on /apc must not affect publication_ethics_policy', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing relevant here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/apc`, fetch_status: 'forbidden', http_status: 403, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'not_met', 'homepage (always-relevant) succeeded and was searched -- a failure on an unrelated /apc page is irrelevant to this criterion')
})

test('a clean 404 on this criterion\'s dedicated guessed path is NOT blocking -- confident not_met once the homepage (always-relevant) was also checked', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Nothing about ethics mentioned here.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'not_met', 'a 404 on a guessed path just means that path does not exist here -- not a fetch problem')
})

test('the homepage itself 404ing (dead/wrong base URL) is unresolved, not a confident absence', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/publication-ethics`, fetch_status: 'not_found', http_status: 404, body: null, retrieved_at: '2026-08-12T00:00:01Z' },
  ]
  const result = resolveCriterion(publicationEthics, pages, WEBSITE)
  assert.equal(result.status, 'unknown')
})

test('no fetch attempts at all (e.g. no website_url on record) -> unknown', () => {
  assert.equal(resolveCriterion(publicationEthics, [], null).status, 'unknown')
})

test('a failure on /about/editorialMasthead specifically only affects editorial_board_public/editor_identity_affiliation_verifiable, not unrelated criteria (real Core-31 run finding)', () => {
  const pages = [
    { url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Welcome to the journal.', retrieved_at: '2026-08-12T00:00:00Z' },
    { url: `${WEBSITE}/about`, fetch_status: 'ok', http_status: 200, body: 'General journal information.', retrieved_at: '2026-08-12T00:00:01Z' },
    { url: `${WEBSITE}/about/editorialMasthead`, fetch_status: 'server_error', http_status: 500, body: null, retrieved_at: '2026-08-12T00:00:02Z' },
  ]
  const advertising = EVIDENCE_CRITERIA.find(c => c.id === 'advertising_sponsorship_disclosure')
  const editorialBoardResult = resolveCriterion(editorialBoard, pages, WEBSITE)
  const advertisingResult = resolveCriterion(advertising, pages, WEBSITE)
  assert.equal(editorialBoardResult.status, 'unknown', 'editorial_board_public IS relevant to the failed masthead page -- must stay unresolved')
  assert.equal(advertisingResult.status, 'not_met', 'advertising_sponsorship_disclosure has nothing to do with the masthead page -- homepage and /about were both checked successfully, so this is a confident absence')
})

test('REVIEW-CAUGHT FALSE POSITIVE, FIXED: editor_identity_affiliation_verifiable no longer fires on a bare "affiliation" mention (e.g. article author affiliations)', () => {
  const criterion = EVIDENCE_CRITERIA.find(c => c.id === 'editor_identity_affiliation_verifiable')
  const pages = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Author affiliation: Department of Biology, State University.', retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, pages, WEBSITE).status, 'not_met', 'a bare "affiliation" mention with no editor-role term must not count as met')

  const realMatch = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Editor-in-Chief: Dr. Jane Smith, Department of Biology.', retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, realMatch, WEBSITE).status, 'met')
})

test('REVIEW-CAUGHT FALSE POSITIVE, FIXED: publisher_ownership_contact no longer fires on a bare "Published by X" byline with no actual contact info', () => {
  const criterion = EVIDENCE_CRITERIA.find(c => c.id === 'publisher_ownership_contact')
  const pages = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Published by Example Publishing Group.', retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, pages, WEBSITE).status, 'not_met', 'naming the publisher alone is not the same as disclosing how to contact them')

  const realMatch = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Contact us: editorial-office@example.com', retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, realMatch, WEBSITE).status, 'met')
})

test('P0-B, FIXED: other_applicable_terms is always not_applicable -- no fixed keyword vocabulary to auto-detect it, so it is never guessed at or penalized', () => {
  const criterion = EVIDENCE_CRITERIA.find(c => c.id === 'other_applicable_terms')
  assert.ok(criterion, 'other_applicable_terms must exist as its own criterion, matching TRANSPARENCY_ITEMS\' 7th item')
  assert.equal(resolveCriterion(criterion, [], null).status, 'not_applicable')
  const pages = [{ url: WEBSITE, fetch_status: 'ok', http_status: 200, body: 'Anything at all, including unrelated real content.', retrieved_at: '2026-08-12T00:00:00Z' }]
  assert.equal(resolveCriterion(criterion, pages, WEBSITE).status, 'not_applicable', 'never flips to met/not_met automatically, regardless of what was crawled')
})

test('resolveAllCriteria returns exactly one item per EVIDENCE_CRITERIA entry, weights matching AJR-E-1.1-SPEC.md exactly (all three dimensions, full totals)', () => {
  const items = resolveAllCriteria([], null)
  assert.equal(items.length, EVIDENCE_CRITERIA.length)
  const totalFor = dim => items
    .filter(i => EVIDENCE_CRITERIA.find(c => c.id === i.id)?.dimension === dim)
    .reduce((s, i) => s + i.weight, 0)
  assert.equal(totalFor('editorial_governance'), 15, 'Dimension 1 (6 items) must sum to 15, matching AJR-E-1.1-SPEC.md § 3')
  assert.equal(totalFor('research_integrity'), 15, 'Dimension 2 (8 items) must sum to 15, matching AJR-E-1.1-SPEC.md § 4')
  assert.equal(totalFor('transparency'), 10, 'Dimension 7 (7 items, INCLUDING other_applicable_terms) must sum to the full 10, matching AJR-E-1.1-SPEC.md § 9 -- the prior 9/10 was the P0-B gap')
})
