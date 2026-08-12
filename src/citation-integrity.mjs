/**
 * Citation integrity checks — implements posi-data/PJR-SPEC.md § 9.
 *
 * Pure functions: each takes already-fetched citation-edge/work/history data
 * (this module does no I/O) and returns a flag object, never an automatic
 * suppression. PJR-SPEC.md § 9 is explicit that a flag feeds a review queue
 * — `status: "suppressed"` in a metric snapshot is a decision made *after*
 * review, using these flags as evidence, not applied automatically by any
 * function here.
 *
 * Citation-edge shape used throughout this module (a directed "citing work
 * -> cited work" pair, resolved to journal level by the caller):
 *   { citing_journal_id, cited_journal_id, citing_publisher?, cited_publisher?, year }
 * Building this edge list (resolving every citing work's own journal) is a
 * separate, comparatively expensive ETL step — see the README's note on
 * which checks this repo's own seed-corpus run could and couldn't execute
 * against real data yet.
 *
 * Every threshold below is a starting point, not a claim of statistical
 * rigor — each is documented with its reasoning so a reviewer can argue with
 * the number, not just the code. All are exported as named constants so a
 * PR changing one is a one-line, reviewable diff.
 */

/** Self-citation rate above this is flagged for review. Typical legitimate
 * journal self-citation rates (a journal citing its own prior articles)
 * mostly sit under ~15-20% across fields; Clarivate itself suppresses a
 * journal's Impact Factor for "anomalous" self-citation, historically citing
 * cases well above this range. 30% is set deliberately conservative (a
 * false-positive-tolerant first pass) — it flags for review, it does not
 * suppress by itself. */
export const SELF_CITATION_RATE_THRESHOLD = 0.30

/** Minimum citations received before a self-citation rate is even computed
 * — below this, one or two self-cites can swing the rate wildly and the
 * number is noise, not signal. */
export const MIN_CITATIONS_FOR_SELF_CITATION_CHECK = 20

/** Share of a journal's total (in + out) citation volume with one single
 * other journal above which the pair is flagged as possible "stacking"
 * (two journals inflating each other's numbers via reciprocal citation). */
export const CITATION_STACKING_SHARE_THRESHOLD = 0.15

/** A stacking pair also needs real volume — two journals exchanging 3
 * citations isn't a pattern, it's arithmetic noise. */
export const MIN_EDGES_FOR_STACKING_CHECK = 15

/** Share of a journal's total window citations landing on its single most-
 * cited article above which citation concentration is flagged — a
 * legitimately broad-based journal spreads citations across many articles;
 * one or two articles driving half the journal's citation count is the
 * profile of a citation-farming or "editorial mega-citation" pattern (or,
 * more innocently, one genuinely landmark paper — that's exactly why this
 * is a review flag, not an automatic penalty). */
export const CONCENTRATION_TOP_SHARE_THRESHOLD = 0.50
/** ...and specifically the top-3 articles' combined share, which catches a
 * small clique of articles even when no single one clears the top-1 bar. */
export const CONCENTRATION_TOP3_SHARE_THRESHOLD = 0.65
export const MIN_CITATIONS_FOR_CONCENTRATION_CHECK = 20

/** Share of a journal's inbound citations coming from other journals under
 * the same publisher, above which publisher-level clustering is flagged.
 * Large multi-journal publishers legitimately cross-cite somewhat (related
 * subject areas, cross-referrals) — this threshold is set well above
 * incidental cross-referral levels. */
export const PUBLISHER_CLUSTER_SHARE_THRESHOLD = 0.40
export const MIN_CITATIONS_FOR_PUBLISHER_CLUSTER_CHECK = 20

/** A year-over-year PCI increase by more than this multiple (e.g. 2.0 =
 * more than doubling) is flagged as a sudden spike worth a look — citation
 * counts for an established journal are typically fairly smooth
 * year-to-year; a >100% jump is unusual enough to be worth a human glance,
 * even though real (non-integrity) causes exist (a single landmark paper,
 * a special issue, entering a new database's indexing). */
export const SPIKE_MULTIPLE_THRESHOLD = 2.0
export const MIN_PRIOR_PCI_FOR_SPIKE_CHECK = 0.1

/** citationCartel(): minimum reciprocal-edge share (of each member's total
 * volume) required for an edge to count toward a cartel cycle — reuses the
 * stacking threshold since it's the same underlying "abnormal reciprocity"
 * signal, just chained across 3+ journals instead of a single pair. */
export const CARTEL_EDGE_SHARE_THRESHOLD = CITATION_STACKING_SHARE_THRESHOLD

/**
 * @param {{ citing_journal_id: string, cited_journal_id: string }[]} citationEdges
 *   - every citation edge landing on this journal's citable items within the
 *   metric window (i.e. cited_journal_id === journalId for all of them; the
 *   caller pre-filters — this function doesn't re-derive that).
 * @param {string} journalId
 * @returns {{ flagged: boolean, rate: number | null, self_citations: number, total_citations: number, reason: string }}
 */
export function selfCitationRate(citationEdges, journalId) {
  const total = citationEdges.length
  if (total < MIN_CITATIONS_FOR_SELF_CITATION_CHECK) {
    return { flagged: false, rate: null, self_citations: 0, total_citations: total, reason: 'insufficient citation volume to evaluate' }
  }
  const selfCitations = citationEdges.filter(e => e.citing_journal_id === journalId).length
  const rate = selfCitations / total
  return {
    flagged: rate > SELF_CITATION_RATE_THRESHOLD,
    rate,
    self_citations: selfCitations,
    total_citations: total,
    reason: rate > SELF_CITATION_RATE_THRESHOLD
      ? `self-citation rate ${(rate * 100).toFixed(1)}% exceeds ${(SELF_CITATION_RATE_THRESHOLD * 100).toFixed(0)}% threshold`
      : 'within normal range',
  }
}

/**
 * Abnormal pairwise reciprocal citation between two journals ("A cites B a
 * lot, B cites A a lot") — checked independently in each direction, since a
 * one-sided heavy citation relationship (a small journal citing a dominant
 * one heavily) is normal field structure, not stacking; it's the
 * *reciprocity* concentrated in one partner that's the signal.
 * @param {{ citing_journal_id: string, cited_journal_id: string }[]} citationEdges
 *   - ALL edges touching journalId, in either direction.
 * @param {string} journalId
 * @returns {{ flagged: boolean, pairs: { partner_journal_id: string, outbound_share: number, inbound_share: number }[] }}
 */
export function citationStacking(citationEdges, journalId) {
  const outbound = citationEdges.filter(e => e.citing_journal_id === journalId && e.cited_journal_id !== journalId)
  const inbound = citationEdges.filter(e => e.cited_journal_id === journalId && e.citing_journal_id !== journalId)
  const totalOut = outbound.length
  const totalIn = inbound.length

  if (totalOut < MIN_EDGES_FOR_STACKING_CHECK && totalIn < MIN_EDGES_FOR_STACKING_CHECK) {
    return { flagged: false, pairs: [] }
  }

  const outByPartner = countBy(outbound, e => e.cited_journal_id)
  const inByPartner = countBy(inbound, e => e.citing_journal_id)
  const partners = new Set([...outByPartner.keys(), ...inByPartner.keys()])

  const pairs = []
  for (const partner of partners) {
    const outboundShare = totalOut > 0 ? (outByPartner.get(partner) ?? 0) / totalOut : 0
    const inboundShare = totalIn > 0 ? (inByPartner.get(partner) ?? 0) / totalIn : 0
    if (outboundShare > CITATION_STACKING_SHARE_THRESHOLD && inboundShare > CITATION_STACKING_SHARE_THRESHOLD) {
      pairs.push({ partner_journal_id: partner, outbound_share: outboundShare, inbound_share: inboundShare })
    }
  }

  return { flagged: pairs.length > 0, pairs }
}

/**
 * Citation concentration in a small number of a journal's own articles.
 * @param {{ work_id: string, citations_in_year: number }[]} journalWorks
 * @returns {{ flagged: boolean, top1_share: number | null, top3_share: number | null, total_citations: number, top_works: string[] }}
 */
export function citationConcentration(journalWorks) {
  const total = journalWorks.reduce((s, w) => s + (w.citations_in_year ?? 0), 0)
  if (total < MIN_CITATIONS_FOR_CONCENTRATION_CHECK) {
    return { flagged: false, top1_share: null, top3_share: null, total_citations: total, top_works: [] }
  }
  const sorted = [...journalWorks].sort((a, b) => (b.citations_in_year ?? 0) - (a.citations_in_year ?? 0))
  const top1 = sorted[0]?.citations_in_year ?? 0
  const top3 = sorted.slice(0, 3).reduce((s, w) => s + (w.citations_in_year ?? 0), 0)
  const top1Share = top1 / total
  const top3Share = top3 / total
  const flagged = top1Share > CONCENTRATION_TOP_SHARE_THRESHOLD || top3Share > CONCENTRATION_TOP3_SHARE_THRESHOLD
  return {
    flagged,
    top1_share: top1Share,
    top3_share: top3Share,
    total_citations: total,
    top_works: sorted.slice(0, 3).map(w => w.work_id),
  }
}

/**
 * Publisher-level citation clustering — an abnormal share of a journal's
 * inbound citations coming from other journals under the same publisher.
 * @param {{ citing_journal_id: string, cited_journal_id: string }[]} citationEdges - all edges landing on journalId
 * @param {string} journalId
 * @param {Map<string,string>} publisherMap - journal_id -> publisher name/id
 * @returns {{ flagged: boolean, same_publisher_share: number | null, total_citations: number }}
 */
export function publisherCitationCluster(citationEdges, journalId, publisherMap) {
  const inbound = citationEdges.filter(e => e.cited_journal_id === journalId)
  const total = inbound.length
  if (total < MIN_CITATIONS_FOR_PUBLISHER_CLUSTER_CHECK) {
    return { flagged: false, same_publisher_share: null, total_citations: total }
  }
  const ownPublisher = publisherMap.get(journalId)
  if (!ownPublisher) {
    return { flagged: false, same_publisher_share: null, total_citations: total }
  }
  const samePublisherCount = inbound.filter(e => publisherMap.get(e.citing_journal_id) === ownPublisher && e.citing_journal_id !== journalId).length
  const share = samePublisherCount / total
  return {
    flagged: share > PUBLISHER_CLUSTER_SHARE_THRESHOLD,
    same_publisher_share: share,
    total_citations: total,
  }
}

/**
 * Sudden citation spike — this year's PCI more than SPIKE_MULTIPLE_THRESHOLD
 * times last year's, with a floor on the prior value so a jump from a
 * near-zero baseline (e.g. 0.02 -> 0.05, technically "150% up") isn't
 * flagged as a spike — it's noise around a small number, not a pattern.
 * @param {{ metric_year: number, pci: number | null }[]} metricHistory - a
 *   single journal's own PCI history across consecutive years, ascending by year.
 * @returns {{ flagged: boolean, prior_year: number | null, prior_pci: number | null, current_pci: number | null, ratio: number | null }}
 */
export function suddenCitationSpike(metricHistory) {
  const sorted = [...metricHistory].sort((a, b) => a.metric_year - b.metric_year)
  if (sorted.length < 2) {
    return { flagged: false, prior_year: null, prior_pci: null, current_pci: null, ratio: null }
  }
  const current = sorted[sorted.length - 1]
  const prior = sorted[sorted.length - 2]
  if (prior.pci == null || current.pci == null || prior.pci < MIN_PRIOR_PCI_FOR_SPIKE_CHECK) {
    return { flagged: false, prior_year: prior.metric_year, prior_pci: prior.pci, current_pci: current.pci, ratio: null }
  }
  const ratio = current.pci / prior.pci
  return {
    flagged: ratio > SPIKE_MULTIPLE_THRESHOLD,
    prior_year: prior.metric_year,
    prior_pci: prior.pci,
    current_pci: current.pci,
    ratio,
  }
}

/**
 * Citation cartel — a cycle of 3+ journals each citing the next in the
 * cycle at an abnormally concentrated share (same per-edge share test as
 * citationStacking, chained around a cycle instead of a single pair).
 * Simple DFS cycle detection over the "abnormal edge" subgraph; this is a
 * detection heuristic, not a claim of intent — a flagged cycle is evidence
 * for a human reviewer, same as every other check in this module.
 * @param {{ citing_journal_id: string, cited_journal_id: string }[]} citationEdges - the full graph
 * @returns {{ flagged: boolean, cycles: string[][] }}
 */
export function citationCartel(citationEdges) {
  const outboundTotals = countBy(citationEdges, e => e.citing_journal_id)
  const pairCounts = new Map() // "A->B" -> count
  for (const e of citationEdges) {
    const key = `${e.citing_journal_id}->${e.cited_journal_id}`
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
  }

  // Build the "abnormal edge" adjacency: A -> B survives only if B's share
  // of A's total outbound citations clears the threshold.
  const adjacency = new Map()
  for (const [key, count] of pairCounts) {
    const [from, to] = key.split('->')
    if (from === to) continue
    const total = outboundTotals.get(from) ?? 0
    if (total === 0) continue
    const share = count / total
    if (share > CARTEL_EDGE_SHARE_THRESHOLD) {
      if (!adjacency.has(from)) adjacency.set(from, [])
      adjacency.get(from).push(to)
    }
  }

  const cycles = []
  const seenCycleKeys = new Set()
  const nodes = [...adjacency.keys()]

  for (const start of nodes) {
    const stack = [[start]]
    while (stack.length > 0) {
      const path = stack.pop()
      const last = path[path.length - 1]
      for (const next of adjacency.get(last) ?? []) {
        if (next === start && path.length >= 3) {
          const key = [...path].sort().join(',')
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key)
            cycles.push(path)
          }
        } else if (!path.includes(next) && path.length < 8) {
          stack.push([...path, next])
        }
      }
    }
  }

  return { flagged: cycles.length > 0, cycles }
}

function countBy(items, keyFn) {
  const m = new Map()
  for (const item of items) {
    const k = keyFn(item)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/**
 * Runs every check that the caller has data for and returns a combined
 * verdict. Does not decide suppression — see this module's header. A
 * missing optional input (e.g. no citationEdges available) simply skips the
 * checks that need it rather than failing the whole run; `checks_run`
 * records which ones actually executed so a caller (or a later human
 * reviewer) can tell "not flagged" apart from "not checked".
 * @param {string} journalId
 * @param {{
 *   citationEdges?: object[],
 *   journalWorks?: object[],
 *   publisherMap?: Map<string,string>,
 *   metricHistory?: object[],
 * }} context
 */
export function evaluateIntegrity(journalId, context = {}) {
  const { citationEdges, journalWorks, publisherMap, metricHistory } = context
  const results = {}
  const checksRun = []

  if (citationEdges) {
    results.self_citation = selfCitationRate(citationEdges.filter(e => e.cited_journal_id === journalId), journalId)
    checksRun.push('self_citation')
    results.stacking = citationStacking(citationEdges, journalId)
    checksRun.push('stacking')
    if (publisherMap) {
      results.publisher_cluster = publisherCitationCluster(citationEdges, journalId, publisherMap)
      checksRun.push('publisher_cluster')
    }
  }
  if (journalWorks) {
    results.concentration = citationConcentration(journalWorks)
    checksRun.push('concentration')
  }
  if (metricHistory) {
    results.spike = suddenCitationSpike(metricHistory)
    checksRun.push('spike')
  }

  const flaggedChecks = Object.entries(results).filter(([, r]) => r.flagged).map(([name]) => name)
  return {
    journal_id: journalId,
    checks_run: checksRun,
    flagged: flaggedChecks.length > 0,
    flagged_checks: flaggedChecks,
    results,
  }
}
