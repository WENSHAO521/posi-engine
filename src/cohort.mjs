/**
 * Peer-cohort construction for the quartile tracks (E-Q, M-Q, Citation Q —
 * see quartile-tracks.mjs/ranking.mjs). The confidence-filtering rule below
 * is shared by all three; the minimum-cohort-size fallback chain is used by
 * E-Q and M-Q only — Citation Q instead follows PJR-SPEC.md § 8's flat
 * rule (primary PSC L2 category, N >= 20, no L1 fallback) via
 * ranking.mjs's rankCategory(), not this module. See quartile-tracks.mjs's
 * header for why the two tracks deliberately differ.
 *
 *   1. Only `psc_confidence` 'high' or 'verified' may enter a peer cohort
 *      (a `medium`/`low`/`unclassified` guess may still be DISPLAYED, but
 *      must never be used to rank a journal against peers). This is the
 *      documented bug fix: cohort-building code that only checks whether
 *      `psc_category` exists (truthy) and ignores `psc_confidence`
 *      entirely will silently rank `low`-confidence guesses as if they
 *      were verified classifications — this module makes that mistake
 *      impossible to make by construction, since building a cohort without
 *      going through buildPeerCohorts()/isRankEligiblePscConfidence() is
 *      the only way to reintroduce the bug.
 *   2. E-Q/M-Q minimum cohort size, with a fallback chain: try PSC Level 3
 *      (>=20) -> Level 2 (>=20) -> Level 1 (>=30) -> no quartile (score
 *      still shown, quartile explicitly "unavailable — insufficient peer
 *      cohort", never forced out of an undersized group).
 *
 * Pure functions only: given already-classified entries (each carrying its
 * own PSC category codes + confidence, already resolved by psc-classify.mjs
 * upstream), group them into cohorts. No I/O.
 */

import { isRankEligiblePscConfidence } from './psc-classify.mjs'

export const COHORT_METHODOLOGY_VERSION = 'COHORT-1.0'

export const MIN_L2_L3_COHORT_SIZE = 20
export const MIN_L1_COHORT_SIZE = 30

/**
 * @param {string} pscCode - e.g. 'P3.03.04' (L3), 'P3.03' (L2), 'P3' (L1)
 * @returns {1|2|3}
 */
export function pscLevel(pscCode) {
  const dotCount = (pscCode.match(/\./g) ?? []).length
  return dotCount + 1
}

/** @returns {string} the Level-2 ancestor of an L2/L3 code, e.g. 'P3.03.04' -> 'P3.03', 'P3.03' -> 'P3.03' */
export function toLevel2(pscCode) {
  const parts = pscCode.split('.')
  return parts.slice(0, 2).join('.')
}

/** @returns {string} the Level-1 ancestor of any code, e.g. 'P3.03.04' -> 'P3' */
export function toLevel1(pscCode) {
  return pscCode.split('.')[0]
}

/**
 * @param {{ id: string, psc_category: string|null, psc_confidence: string|null }[]} entries
 *   - one per journal being considered for a single lifecycle/track cohort
 *     pass (caller has already filtered to the right lifecycle stage / track
 *     eligibility — this module only handles the PSC/confidence/size rules).
 * @returns {{ id: string, psc_category: string, psc_confidence: string }[]}
 *   entries that are rank-eligible on confidence grounds (categorized, not
 *   yet grouped into cohorts — see buildPeerCohorts()).
 */
export function filterRankEligibleByConfidence(entries) {
  return entries.filter(e => e.psc_category && isRankEligiblePscConfidence(e.psc_confidence))
}

/**
 * Groups rank-eligible entries into peer cohorts, applying the
 * L3>=20 -> L2>=20 -> L1>=30 -> unavailable fallback chain PER
 * L3-category-group (a cohort's fallback decision is made independently
 * for each L3 group of entries that share a common L2/L1 ancestor, not
 * globally) — see § 5/§ 7 in the source specs.
 *
 * @param {{ id: string, psc_category: string, psc_confidence: string }[]} entries
 *   - already confidence-filtered (see filterRankEligibleByConfidence()) —
 *   this function does not re-check confidence itself, so a caller must not
 *   skip that step.
 * @returns {{ cohort_key: string, cohort_level: 1|2|3, member_ids: string[], entries: object[] }[]}
 *   one cohort per distinct resolved grouping. Entries whose category
 *   cannot form ANY eligible cohort (even at L1) are omitted — the caller
 *   is responsible for marking those journals "quartile unavailable —
 *   insufficient peer cohort" using the score they still have.
 */
export function buildPeerCohorts(entries) {
  // Group first by the finest level present in the data (L3 if any entry
  // uses an L3 code, else L2). POSI's current taxonomy is L1/L2 only for
  // classifyPsc() output (see psc-classify.mjs), but this function is
  // written against the general L1-L3 rule so it does not need to change
  // again once L3 codes exist (framework: "Future L3: L3>=20 -> L2>=20 ->
  // L1>=30 fallback chain").
  const byL3OrSelf = new Map()
  for (const e of entries) {
    const level = pscLevel(e.psc_category)
    const key = level === 3 ? e.psc_category : `${e.psc_category}::no-l3`
    if (!byL3OrSelf.has(key)) byL3OrSelf.set(key, [])
    byL3OrSelf.get(key).push(e)
  }

  const cohorts = []
  const consumedIds = new Set()

  // Pass 1: any L3-level group that alone clears MIN_L2_L3_COHORT_SIZE.
  for (const [key, group] of byL3OrSelf) {
    if (pscLevel(group[0].psc_category) === 3 && group.length >= MIN_L2_L3_COHORT_SIZE) {
      cohorts.push({ cohort_key: key, cohort_level: 3, member_ids: group.map(e => e.id), entries: group })
      for (const e of group) consumedIds.add(e.id)
    }
  }

  const remaining = entries.filter(e => !consumedIds.has(e.id))

  // Pass 2: group remaining entries by Level 2.
  const byL2 = new Map()
  for (const e of remaining) {
    const key = toLevel2(e.psc_category)
    if (!byL2.has(key)) byL2.set(key, [])
    byL2.get(key).push(e)
  }
  for (const [key, group] of byL2) {
    if (group.length >= MIN_L2_L3_COHORT_SIZE) {
      cohorts.push({ cohort_key: key, cohort_level: 2, member_ids: group.map(e => e.id), entries: group })
      for (const e of group) consumedIds.add(e.id)
    }
  }

  const stillRemaining = entries.filter(e => !consumedIds.has(e.id))

  // Pass 3: fall back to Level 1 for whatever is left.
  const byL1 = new Map()
  for (const e of stillRemaining) {
    const key = toLevel1(e.psc_category)
    if (!byL1.has(key)) byL1.set(key, [])
    byL1.get(key).push(e)
  }
  for (const [key, group] of byL1) {
    if (group.length >= MIN_L1_COHORT_SIZE) {
      cohorts.push({ cohort_key: key, cohort_level: 1, member_ids: group.map(e => e.id), entries: group })
    }
    // else: no eligible cohort at any level — omitted, per this function's
    // contract (caller shows the score with "quartile unavailable").
  }

  return cohorts
}
