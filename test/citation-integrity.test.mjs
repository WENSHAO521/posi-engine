import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selfCitationRate,
  citationStacking,
  citationConcentration,
  publisherCitationCluster,
  suddenCitationSpike,
  citationCartel,
  evaluateIntegrity,
  SELF_CITATION_RATE_THRESHOLD,
  MIN_CITATIONS_FOR_SELF_CITATION_CHECK,
} from '../src/citation-integrity.mjs'

function edges(n, citing, cited) {
  return Array.from({ length: n }, () => ({ citing_journal_id: citing, cited_journal_id: cited }))
}

test('selfCitationRate flags a journal citing itself above the threshold', () => {
  const es = [...edges(35, 'J1', 'J1'), ...edges(15, 'J2', 'J1')] // 35/50 = 70% self-citation
  const result = selfCitationRate(es, 'J1')
  assert.equal(result.flagged, true)
  assert.equal(result.rate, 0.7)
})

test('selfCitationRate does not flag a normal rate', () => {
  const es = [...edges(5, 'J1', 'J1'), ...edges(45, 'J2', 'J1')] // 10%
  const result = selfCitationRate(es, 'J1')
  assert.equal(result.flagged, false)
})

test('selfCitationRate skips evaluation below the minimum citation-volume floor (noise, not signal)', () => {
  const es = edges(MIN_CITATIONS_FOR_SELF_CITATION_CHECK - 1, 'J1', 'J1') // 100% self-cited but tiny volume
  const result = selfCitationRate(es, 'J1')
  assert.equal(result.flagged, false)
  assert.equal(result.rate, null)
})

test('selfCitationRate threshold boundary is exclusive (> not >=)', () => {
  // Construct a rate exactly at the threshold.
  const n = 100
  const selfCount = SELF_CITATION_RATE_THRESHOLD * n
  const es = [...edges(selfCount, 'J1', 'J1'), ...edges(n - selfCount, 'J2', 'J1')]
  const result = selfCitationRate(es, 'J1')
  assert.equal(result.flagged, false, 'exactly at threshold should not flag')
})

test('citationStacking flags a pair with abnormally concentrated reciprocal citation', () => {
  const es = [
    ...edges(20, 'J1', 'J2'), // J1 -> J2, all of J1's outbound
    ...edges(20, 'J2', 'J1'), // J2 -> J1, all of J2's outbound
  ]
  const result = citationStacking(es, 'J1')
  assert.equal(result.flagged, true)
  assert.equal(result.pairs[0].partner_journal_id, 'J2')
})

test('citationStacking does not flag one-sided heavy citation (normal field structure)', () => {
  // J1 cites J2 heavily (a small journal citing a dominant one) — 100% of
  // J1's outbound. But J2's citations back to J1 are a small share of J1's
  // total INBOUND (diluted by J3's unrelated citations) — reciprocity
  // concentrated in one partner is the signal, not one-sided volume alone.
  const es = [...edges(20, 'J1', 'J2'), ...edges(1, 'J2', 'J1'), ...edges(19, 'J3', 'J1')]
  const result = citationStacking(es, 'J1')
  assert.equal(result.flagged, false)
})

test('citationStacking requires minimum edge volume before evaluating', () => {
  const es = [...edges(5, 'J1', 'J2'), ...edges(5, 'J2', 'J1')]
  const result = citationStacking(es, 'J1')
  assert.equal(result.flagged, false)
  assert.deepEqual(result.pairs, [])
})

test('citationConcentration flags a journal whose top article dominates its citations', () => {
  const works = [
    { work_id: 'W1', citations_in_year: 60 },
    { work_id: 'W2', citations_in_year: 5 },
    { work_id: 'W3', citations_in_year: 5 },
    { work_id: 'W4', citations_in_year: 30 },
  ]
  const result = citationConcentration(works)
  assert.equal(result.flagged, true)
  assert.equal(result.top1_share, 0.6)
})

test('citationConcentration does not flag a broad-based citation distribution', () => {
  const works = Array.from({ length: 20 }, () => ({ work_id: 'W', citations_in_year: 5 })) // 100 total, evenly spread
  const result = citationConcentration(works)
  assert.equal(result.flagged, false)
})

test('citationConcentration skips below the minimum citation floor', () => {
  const works = [{ work_id: 'W1', citations_in_year: 5 }]
  const result = citationConcentration(works)
  assert.equal(result.flagged, false)
  assert.equal(result.top1_share, null)
})

test('publisherCitationCluster flags an abnormal same-publisher inbound share', () => {
  const publisherMap = new Map([['J1', 'Elsevier'], ['J2', 'Elsevier'], ['J3', 'Elsevier'], ['J4', 'Wiley']])
  const es = [...edges(20, 'J2', 'J1'), ...edges(5, 'J4', 'J1')] // 20/25 = 80% from same-publisher J2
  const result = publisherCitationCluster(es, 'J1', publisherMap)
  assert.equal(result.flagged, true)
  assert.equal(result.same_publisher_share, 0.8)
})

test('publisherCitationCluster does not flag a diversified citation base', () => {
  const publisherMap = new Map([['J1', 'Elsevier'], ['J2', 'Wiley'], ['J3', 'Springer'], ['J4', 'SAGE']])
  const es = [...edges(10, 'J2', 'J1'), ...edges(10, 'J3', 'J1'), ...edges(10, 'J4', 'J1')]
  const result = publisherCitationCluster(es, 'J1', publisherMap)
  assert.equal(result.flagged, false)
})

test('suddenCitationSpike flags more than a doubling year-over-year', () => {
  const history = [
    { metric_year: 2024, pci: 2.0 },
    { metric_year: 2025, pci: 5.0 }, // 2.5x
  ]
  const result = suddenCitationSpike(history)
  assert.equal(result.flagged, true)
  assert.equal(result.ratio, 2.5)
})

test('suddenCitationSpike ignores order and sorts by metric_year itself', () => {
  const history = [
    { metric_year: 2025, pci: 5.0 },
    { metric_year: 2024, pci: 2.0 },
  ]
  const result = suddenCitationSpike(history)
  assert.equal(result.flagged, true)
})

test('suddenCitationSpike does not flag noise around a near-zero baseline', () => {
  const history = [
    { metric_year: 2024, pci: 0.02 },
    { metric_year: 2025, pci: 0.06 }, // technically 3x, but prior value is below the floor
  ]
  const result = suddenCitationSpike(history)
  assert.equal(result.flagged, false)
})

test('suddenCitationSpike returns not-flagged with fewer than two years of history', () => {
  const result = suddenCitationSpike([{ metric_year: 2025, pci: 5.0 }])
  assert.equal(result.flagged, false)
})

test('citationCartel detects a 3-journal reciprocal cycle each citing the next abnormally', () => {
  const es = [
    ...edges(20, 'A', 'B'), // all of A's outbound goes to B
    ...edges(20, 'B', 'C'), // all of B's outbound goes to C
    ...edges(20, 'C', 'A'), // all of C's outbound goes to A
  ]
  const result = citationCartel(es)
  assert.equal(result.flagged, true)
  assert.equal(result.cycles.length, 1)
  assert.equal(result.cycles[0].length, 3)
})

test('citationCartel does not flag a diffuse, acyclic citation graph (no path leads back to its start)', () => {
  const es = [
    ...edges(5, 'A', 'B'), ...edges(5, 'A', 'C'), ...edges(5, 'A', 'D'),
    ...edges(5, 'B', 'C'), ...edges(5, 'B', 'D'), ...edges(5, 'C', 'D'),
  ]
  const result = citationCartel(es)
  assert.equal(result.flagged, false)
})

test('evaluateIntegrity only runs checks it has data for, and records which ran', () => {
  const result = evaluateIntegrity('J1', { journalWorks: [{ work_id: 'W1', citations_in_year: 5 }] })
  assert.deepEqual(result.checks_run, ['concentration'])
  assert.equal(result.results.self_citation, undefined)
})

test('evaluateIntegrity aggregates flags from every check that ran', () => {
  const journalWorks = [
    { work_id: 'W1', citations_in_year: 60 },
    { work_id: 'W2', citations_in_year: 5 },
    { work_id: 'W3', citations_in_year: 5 },
    { work_id: 'W4', citations_in_year: 30 },
  ]
  const citationEdges = [...edges(35, 'J1', 'J1'), ...edges(15, 'J2', 'J1')]
  const result = evaluateIntegrity('J1', { journalWorks, citationEdges })
  assert.equal(result.flagged, true)
  assert.ok(result.flagged_checks.includes('concentration'))
  assert.ok(result.flagged_checks.includes('self_citation'))
})

test('evaluateIntegrity is not flagged when no check finds anything wrong', () => {
  const result = evaluateIntegrity('J1', { metricHistory: [{ metric_year: 2024, pci: 2 }, { metric_year: 2025, pci: 2.1 }] })
  assert.equal(result.flagged, false)
})
