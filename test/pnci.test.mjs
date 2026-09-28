import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBaselines, calculatePNCI, cellsFromItems, MIN_BASELINE_ITEMS } from '../src/pnci.mjs'
import { rankCitationEdition } from '../src/citation-ranking.mjs'

const hist = counts => { const m = new Map(); for (const c of counts) m.set(c, (m.get(c) ?? 0) + 1); return [...m.entries()] }

test('cellsFromItems groups by year and type, absent count is 0', () => {
  const cells = cellsFromItems([
    { published_year: 2023, document_type: 'research-article', is_referenced_by_count: 3 },
    { published_year: 2023, document_type: 'research-article', is_referenced_by_count: null },
    { published_year: 2024, document_type: 'review-article', is_referenced_by_count: 5 },
    { published_year: null, document_type: 'research-article', is_referenced_by_count: 9 },
  ])
  assert.deepEqual(cells, [
    { y: 2023, t: 'research-article', h: [[0, 1], [3, 1]] },
    { y: 2024, t: 'review-article', h: [[5, 1]] },
  ])
})

test('PNCI is the item-level mean of C / E(field, year, type)', () => {
  // Field baseline for 2023 research articles: mean 2 over 60 items.
  const peers = { field: 'P1.01', cells: [{ y: 2023, t: 'research-article', h: hist([...Array(30).fill(1), ...Array(30).fill(3)]) }] }
  const j = { field: 'P1.01', cells: [{ y: 2023, t: 'research-article', h: hist([2, 4]) }] }
  const b = buildBaselines([peers, j])
  const g = b.fyt.get('P1.01|2023|research-article')
  assert.equal(g.n, 62)
  const r = calculatePNCI(j, b)
  assert.ok(Math.abs(r.pnci - ((2 / g.mean + 4 / g.mean) / 2)) < 1e-12)
  assert.equal(r.normalization, 'field_year_type')
  assert.equal(r.eligible_items, 2)
  assert.deepEqual(r.publication_years, [2023])
})

test('a journal at the field mean has PNCI 1', () => {
  const j = { field: 'P2.01', cells: [{ y: 2022, t: 'research-article', h: hist(Array(MIN_BASELINE_ITEMS).fill(4)) }] }
  const r = calculatePNCI(j, buildBaselines([j]))
  assert.equal(r.pnci, 1)
})

test('small (field, year, type) group falls back to (field, year)', () => {
  const big = { field: 'P3.01', cells: [{ y: 2022, t: 'research-article', h: hist(Array(MIN_BASELINE_ITEMS).fill(2)) }] }
  const j = { field: 'P3.01', cells: [{ y: 2022, t: 'review-article', h: hist([10]) }] }
  const r = calculatePNCI(j, buildBaselines([big, j]))
  assert.equal(r.normalization, 'field_year_type+field_year_fallback')
  assert.ok(r.pnci > 1)
})

test('no field or no citations anywhere: PNCI null, no throw', () => {
  const j = { field: null, cells: [{ y: 2022, t: 'research-article', h: hist([1]) }] }
  assert.equal(calculatePNCI(j, buildBaselines([j])).pnci, null)
  const z = { field: 'P1.02', cells: [{ y: 2022, t: 'research-article', h: hist([0, 0]) }] }
  const r = calculatePNCI(z, buildBaselines([z]))
  assert.equal(r.pnci, null)
  assert.equal(r.items_without_baseline, 2)
  assert.equal(calculatePNCI({ field: 'P1.02', cells: [] }, buildBaselines([])).pnci, null)
})

function journal(i, pnci, over = {}) {
  return { journal_id: `J${i}`, pnci, eligible_items: 40, publication_years: [2023, 2024], coverage: 1, psc_category: 'P1.01', psc_confidence: 'high', ...over }
}

test('edition: category N=50 gets official zones; ties share everything', () => {
  const entries = Array.from({ length: 50 }, (_, i) => journal(i, 50 - i))
  entries[10].pnci = entries[11].pnci
  const recs = rankCitationEdition(entries, { metric_year: 2026, snapshot_date: '2026-09-28' })
  const [a, b] = [recs[10], recs[11]]
  assert.equal(a.citation_rank, b.citation_rank)
  assert.equal(a.citation_percentile, b.citation_percentile)
  assert.equal(a.citation_quartile, b.citation_quartile)
  assert.equal(a.posi_zone, b.posi_zone)
  assert.equal(recs[0].citation_ranking_status, 'official')
  assert.equal(recs[0].posi_zone, 1)
  assert.equal(recs[0].zone_status, 'official')
  assert.equal(recs[0].citation_rank_total, 50)
  for (const r of recs) assert.ok(r.citation_quartile && r.citation_rank && r.citation_percentile != null)
})

test('edition: N=30 provisional zone, N=20 no zone, N=19 insufficient category', () => {
  const at = n => rankCitationEdition(Array.from({ length: n }, (_, i) => journal(i, n - i)), { metric_year: 2026, snapshot_date: 'x' })
  assert.equal(at(30)[0].zone_status, 'provisional')
  assert.equal(at(49)[0].zone_status, 'provisional')
  assert.equal(at(29)[0].posi_zone, null)
  assert.equal(at(20)[0].citation_quartile, 'Q1')
  const small = at(19)
  assert.equal(small[0].citation_ranking_status, 'insufficient_category')
  assert.equal(small[0].citation_rank, null)
  assert.equal(small[0].citation_quartile, null)
  assert.equal(small[0].pnci, 19)
})

test('edition: provisional journals get a quartile but no zone; PCS never decides order', () => {
  const entries = Array.from({ length: 60 }, (_, i) => journal(i, 60 - i, { pcs: i }))
  entries[0].eligible_items = 14
  const recs = rankCitationEdition(entries, { metric_year: 2026, snapshot_date: 'x' })
  assert.equal(recs[0].citation_ranking_status, 'provisional')
  assert.equal(recs[0].citation_quartile, 'Q1')
  assert.equal(recs[0].posi_zone, null)
  assert.equal(recs[0].citation_rank, 1) // highest PNCI, lowest PCS
})

test('edition: low coverage, few items, multidisciplinary and low confidence are not ranked', () => {
  const base = Array.from({ length: 25 }, (_, i) => journal(i, 25 - i))
  const extra = [
    journal('cov', 99, { coverage: 0.5 }),
    journal('few', 99, { eligible_items: 3 }),
    journal('md', 99, { psc_confidence: 'multidisciplinary' }),
    journal('low', 99, { psc_confidence: 'low' }),
  ]
  const recs = rankCitationEdition([...base, ...extra], { metric_year: 2026, snapshot_date: 'x' })
  const by = Object.fromEntries(recs.map(r => [r.journal_id, r]))
  assert.equal(by.Jcov.citation_ranking_status, 'incomplete_coverage')
  assert.equal(by.Jfew.citation_ranking_status, 'insufficient_items')
  assert.equal(by.Jmd.citation_ranking_status, 'not_available')
  assert.equal(by.Jmd.ranking_category_id, null)
  assert.equal(by.Jlow.citation_ranking_status, 'not_available')
  assert.equal(by.J0.citation_rank_total, 25)
})

test('edition invariants hold for a built edition and catch a broken record', async () => {
  const { validateCitationEdition } = await import('../src/citation-ranking-check.mjs')
  const recs = rankCitationEdition(Array.from({ length: 60 }, (_, i) => journal(i, Math.floor(i / 2))), { metric_year: 2026, snapshot_date: 'x' })
  assert.deepEqual(validateCitationEdition(recs), [])
  const broken = recs.map(r => ({ ...r }))
  broken[0].citation_quartile = 'Q1'
  broken[1].posi_zone = null
  assert.ok(validateCitationEdition(broken).length >= 2)
})
