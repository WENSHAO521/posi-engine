import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reachedSource, shouldReplace, mergeJournalSnapshot } from '../scripts/apply-evidence-refresh.mjs'

test('reachedSource: site crawl counts as reached when any page came back ok', () => {
  assert.equal(reachedSource('journals', { fetched_pages: [{ fetch_status: 'not_found' }, { fetch_status: 'ok' }] }), true)
})

test('reachedSource: site crawl where every page was refused is not reached', () => {
  assert.equal(reachedSource('journals', { fetched_pages: [{ fetch_status: 'forbidden' }, { fetch_status: 'forbidden' }] }), false)
  assert.equal(reachedSource('journals', { fetched_pages: [] }), false)
})

test('reachedSource: article sample needs a Crossref 200', () => {
  assert.equal(reachedSource('works', { crossref_status: 200 }), true)
  assert.equal(reachedSource('works', { crossref_status: 403 }), false)
  assert.equal(reachedSource('works', { crossref_status: null }), false)
})

test('reachedSource: output history needs the OpenAlex record read', () => {
  assert.equal(reachedSource('output', { counts_by_year: { 2025: 3 } }), true)
  assert.equal(reachedSource('output', { counts_by_year: {} }), true)
  assert.equal(reachedSource('output', { counts_by_year: null, fetch_error: 'HTTP 403' }), false)
})

test('reachedSource: unknown kind throws', () => {
  assert.throws(() => reachedSource('publishers', {}))
})

test('shouldReplace: a crawl cut short by its host never replaces a stored complete one', () => {
  // Real case (2026-10 rerate): two timeouts on one journal's site dropped
  // its coverage to 48% and its rating to not_rateable.
  const ok = { fetch_status: 'ok' }
  const partial = { fetched_pages: [ok], evidence_snapshot_status: 'partial_source_unavailable' }
  const complete = { fetched_pages: [ok], evidence_snapshot_status: 'complete' }
  assert.equal(shouldReplace('journals', partial, complete), false)
  assert.equal(shouldReplace('journals', partial, { ...partial }), true)
  assert.equal(shouldReplace('journals', complete, partial), true)
  assert.equal(shouldReplace('journals', partial, null), true)
  assert.equal(shouldReplace('journals', { fetched_pages: [{ fetch_status: 'timeout' }] }, partial), false)
})

test('shouldReplace: a stored snapshot without the status field is judged by its pages', () => {
  const partial = { fetched_pages: [{ fetch_status: 'ok' }], evidence_snapshot_status: 'partial_source_unavailable' }
  assert.equal(shouldReplace('journals', partial, { fetched_pages: [{ url: 'https://a.example/', fetch_status: 'ok' }] }), false)
  assert.equal(shouldReplace('journals', partial, { fetched_pages: [{ url: 'https://a.example/', fetch_status: 'ok' }, { url: 'https://a.example/x', fetch_status: 'timeout' }] }), true)
})

test('shouldReplace: a stored complete snapshot that never reached its source does not block a fresh partial one', () => {
  const partial = { fetched_pages: [{ fetch_status: 'ok' }], evidence_snapshot_status: 'partial_source_unavailable' }
  const storedForbidden = { fetched_pages: [{ url: 'https://a.example/', fetch_status: 'forbidden' }], evidence_snapshot_status: 'complete' }
  assert.equal(shouldReplace('journals', partial, storedForbidden), true)
})

test('reachedSource: a journal whose site refused everything is reached when its Crossref deposits were read', () => {
  const blocked = [{ url: 'https://x/', fetch_status: 'forbidden', http_status: 403 }]
  assert.equal(reachedSource('journals', { fetched_pages: blocked }), false)
  assert.equal(reachedSource('journals', { fetched_pages: blocked, crossref_evidence: { failed: false, articles: 100 } }), true)
  assert.equal(reachedSource('journals', { fetched_pages: blocked, crossref_evidence: { failed: true, articles: 0 } }), false)
  assert.equal(reachedSource('journals', { fetched_pages: blocked, crossref_evidence: { failed: false, articles: 0 } }), false)
})

test('mergeJournalSnapshot: a failed Crossref fetch keeps the Crossref evidence found before', () => {
  const stored = { snapshot_date: '2026-10-07', evidence_items: [
    { id: 'corrections_retractions_policy', weight: 3, status: 'met', source: 'crossref', crossref_until: '2026-10-07' },
    { id: 'copyright_licensing', weight: 2, status: 'met', source: 'crossref', crossref_until: '2026-10-07' },
  ] }
  const fresh = { crossref_evidence: { failed: true, articles: 0, since: '2023-11-07', until: '2026-11-07' }, dimension_scores: { research_integrity: null }, evidence_items: [
    { id: 'corrections_retractions_policy', weight: 3, status: 'blocked' },
    { id: 'copyright_licensing', weight: 2, status: 'not_met' },
  ] }
  const merged = mergeJournalSnapshot(fresh, stored)
  assert.deepEqual(merged.evidence_items.map(i => i.status), ['met', 'not_met'], 'a site verdict is never replaced')
  assert.equal(merged.evidence_items[0].carried_over_from, '2026-10-07')
  assert.equal(merged.crossref_evidence.carried_over, 1)
  assert.equal(merged.site_evidence_coverage_percent, 100)
  assert.ok(merged.dimension_scores.research_integrity, 'dimension scores recomputed from the merged items')
  const ok = { ...fresh, crossref_evidence: { failed: false, articles: 50 } }
  assert.equal(mergeJournalSnapshot(ok, stored), ok, 'a successful fetch replaces as usual')
})

test('mergeJournalSnapshot: carried Crossref evidence must lie in the fresh run\'s window', () => {
  const item = until => ({ id: 'corrections_retractions_policy', weight: 3, status: 'met', source: 'crossref', crossref_until: until })
  const fresh = { crossref_evidence: { failed: true, articles: 0, since: '2023-10-07', until: '2026-10-07' },
    evidence_items: [{ id: 'corrections_retractions_policy', weight: 3, status: 'blocked' }] }
  assert.equal(mergeJournalSnapshot(fresh, { evidence_items: [item('2026-11-07')] }), fresh, 'evidence from after the rating date is not carried')
  assert.equal(mergeJournalSnapshot(fresh, { evidence_items: [item('2023-01-01')] }), fresh, 'evidence aged out of the window is not carried')
  assert.equal(mergeJournalSnapshot(fresh, { evidence_items: [{ ...item(null) }] }), fresh, 'evidence without a sample date is not carried')
  assert.equal(mergeJournalSnapshot(fresh, { evidence_items: [item('2026-09-07')] }).evidence_items[0].status, 'met')
})

test('shouldReplace: a stored snapshot that reached only Crossref does not block a partial site crawl', () => {
  const stored = { evidence_snapshot_status: 'complete', fetched_pages: [{ url: 'https://x/', fetch_status: 'forbidden', http_status: 403 }], crossref_evidence: { failed: false, articles: 100 } }
  const fresh = { evidence_snapshot_status: 'partial_source_unavailable', fetched_pages: [{ url: 'https://x/', fetch_status: 'ok', http_status: 200 }, { url: 'https://x/a', fetch_status: 'timeout', http_status: null }] }
  assert.equal(shouldReplace('journals', fresh, stored), true)
})
