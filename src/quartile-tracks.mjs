/**
 * E-Q / M-Q / Citation Q — three independent quartile tracks sharing one
 * ranking algorithm. Implements the "POSI Journal Evaluation & Ranking
 * Framework 1.0" rule (also stated in posi-data/AJR-SPEC.md § 5): "All
 * three quartile systems use the identical midrank-percentile algorithm
 * already specified in PJR-SPEC.md's RANK-1.0 — only the input score
 * differs (AJR-E score / AJR-M score / PCI) and only the label differs."
 * And: "Always display the full name (E-Q / M-Q / Citation Q), never bare
 * Q1."
 *
 * This module owns the generic midrank/percentile core (extracted here so
 * ranking.mjs's existing rankCategory() — which this module reuses for the
 * Citation Q track — and the new AJR-E/AJR-M cohort ranking share one
 * implementation, not two copies that could silently drift). See
 * percentileMidrank() below.
 *
 * Resolved cohort rule (posi-data/AJR-SPEC.md § 5 vs PJR-SPEC.md § 8,
 * settled 2026-08-13 — see posi-data/PJR-SPEC.md § 8 for the authoritative
 * text): E-Q and M-Q use the L3>=20 -> L2>=20 -> L1>=30 fallback chain,
 * via cohort.mjs's buildPeerCohorts(). Citation Q does not: it keeps
 * PJR-SPEC.md § 8's original flat rule — primary PSC L2 category only,
 * N >= 20, no L1 fallback — via rankCategory() below, UNCHANGED from its
 * already-published behavior. The two tracks are intentionally different,
 * not accidentally inconsistent.
 */

import { rankCategory, RANKING_METHODOLOGY_VERSION, MIN_CATEGORY_SIZE } from './ranking.mjs'
import { filterRankEligibleByConfidence, buildPeerCohorts } from './cohort.mjs'

export const TRACK_LABELS = {
  early_stage: 'E-Q',
  mature: 'M-Q',
  citation: 'Citation Q',
}

/**
 * Generic descending-value midrank/percentile/quartile core — the same
 * math as ranking.mjs's rankCategory(), extracted so both PCI-based
 * Citation Q and AJR-E/AJR-M-score-based E-Q/M-Q share exactly one
 * implementation.
 * @param {{ id: string, value: number }[]} entries - pre-filtered to
 *   whatever cohort/eligibility rule the caller applies; every entry here
 *   is treated as ranked (no MIN_CATEGORY_SIZE gate at this layer — gating
 *   is the caller's job, same separation as rankCategory()).
 * @returns {{ id: string, value: number, rank: number, rank_mid: number, percentile: number, quartile: 'Q1'|'Q2'|'Q3'|'Q4', tied_with: string[] }[]}
 */
export function percentileMidrank(entries) {
  const n = entries.length
  const sorted = [...entries].sort((a, b) => b.value - a.value)

  const blocks = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j].value === sorted[i].value) j++
    blocks.push(sorted.slice(i, j))
    i = j
  }

  const records = []
  let position = 1
  for (const block of blocks) {
    const blockSize = block.length
    const rankMid = position + (blockSize - 1) / 2
    const percentile = 100 * (n - rankMid + 0.5) / n
    const quartile = toQuartile(percentile)
    const tiedIds = block.map(e => e.id)
    for (const entry of block) {
      records.push({
        id: entry.id,
        value: entry.value,
        rank: position,
        rank_mid: Math.round(rankMid * 100) / 100,
        percentile: Math.round(percentile * 100) / 100,
        quartile,
        tied_with: tiedIds.filter(id => id !== entry.id),
      })
    }
    position += blockSize
  }
  return records
}

function toQuartile(percentile) {
  if (percentile >= 75) return 'Q1'
  if (percentile >= 50) return 'Q2'
  if (percentile >= 25) return 'Q3'
  return 'Q4'
}

/**
 * Builds the display label per the "never bare Q1" rule.
 * @param {'early_stage'|'mature'|'citation'} track
 * @param {'Q1'|'Q2'|'Q3'|'Q4'|null} quartile
 * @returns {string|null} e.g. "E-Q1", "M-Q3", "Citation Q2", or null
 */
export function quartileLabel(track, quartile) {
  if (!quartile) return null
  const n = quartile.replace('Q', '')
  return track === 'citation' ? `Citation Q${n}` : `${TRACK_LABELS[track]}${n}`
}

/**
 * E-Q / M-Q: score a lifecycle-stage cohort (already confidence-filtered
 * and gathered into a PSC peer cohort via cohort.mjs's buildPeerCohorts()).
 * @param {{ id: string, score: number }[]} cohortEntries - one cohort's
 *   worth of AJR-E or AJR-M scores (already the output of
 *   buildPeerCohorts() — one specific cohort's `.entries`, joined with each
 *   journal's score).
 * @param {'early_stage'|'mature'} track
 * @param {{ cohort_key: string, cohort_level: number, metric_year: number }} context
 * @returns {object[]}
 */
export function rankTrackCohort(cohortEntries, track, context) {
  const midrank = percentileMidrank(cohortEntries.map(e => ({ id: e.id, value: e.score })))
  const cohortSize = cohortEntries.length
  return midrank.map(r => ({
    journal_id: r.id,
    track,
    cohort_key: context.cohort_key,
    cohort_level: context.cohort_level,
    metric_year: context.metric_year,
    score: r.value,
    rank: r.rank,
    rank_mid: r.rank_mid,
    cohort_size: cohortSize,
    percentile: r.percentile,
    quartile: r.quartile,
    quartile_label: quartileLabel(track, r.quartile),
    ranking_method: 'score_midrank',
    tied_with: r.tied_with,
    methodology_version: RANKING_METHODOLOGY_VERSION,
  }))
}

/**
 * End-to-end E-Q or M-Q: takes every rank-candidate journal for a single
 * lifecycle stage (already restricted to that stage by the caller — this
 * module does not itself know about lifecycle.mjs), applies the
 * confidence gate + L3/L2/L1 fallback cohort-building, and ranks each
 * resulting cohort. Journals that don't clear any cohort threshold are
 * returned separately with `quartile: null` / `ranking_method:
 * 'unavailable'` — score is not discarded, only the quartile is withheld.
 * @param {{ id: string, score: number, psc_category: string|null, psc_confidence: string|null }[]} entries
 * @param {'early_stage'|'mature'} track
 * @param {number} metric_year
 * @returns {object[]}
 */
export function rankLifecycleTrack(entries, track, metric_year) {
  const eligible = filterRankEligibleByConfidence(entries)
  const cohorts = buildPeerCohorts(eligible)
  const rankedIds = new Set()
  const results = []

  for (const cohort of cohorts) {
    const scored = cohort.entries.map(e => ({ id: e.id, score: entries.find(x => x.id === e.id).score }))
    const records = rankTrackCohort(scored, track, { cohort_key: cohort.cohort_key, cohort_level: cohort.cohort_level, metric_year })
    for (const r of records) rankedIds.add(r.journal_id)
    results.push(...records)
  }

  for (const e of entries) {
    if (rankedIds.has(e.id)) continue
    results.push({
      journal_id: e.id,
      track,
      cohort_key: null,
      cohort_level: null,
      metric_year,
      score: e.score,
      rank: null,
      rank_mid: null,
      cohort_size: null,
      percentile: null,
      quartile: null,
      quartile_label: null,
      ranking_method: 'unavailable',
      tied_with: [],
      methodology_version: RANKING_METHODOLOGY_VERSION,
    })
  }

  return results
}

/**
 * Citation Q: a thin, label-adding wrapper around the EXISTING
 * rankCategory() (PJR-SPEC.md § 8, unchanged — see this module's header
 * for why the L1 fallback is deliberately NOT applied here).
 * @param {{ journal_id: string, pci: number }[]} entries
 * @param {{ category_code: string, metric_year: number }} context
 * @returns {object[]} rankCategory()'s existing records, each with
 *   `quartile_label` added (e.g. "Citation Q1") and `track: 'citation'`.
 */
export function rankCitationTrack(entries, context) {
  return rankCategory(entries, context).map(r => ({
    ...r,
    track: 'citation',
    quartile_label: quartileLabel('citation', r.quartile),
  }))
}

export { MIN_CATEGORY_SIZE }
