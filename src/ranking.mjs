/**
 * Ranking calculator — implements posi-data/PJR-SPEC.md § 8.
 *
 * Pure functions: given a list of { journal_id, pci } for one PSC category
 * and metric_year, produce one ranking record per journal per
 * schema/ranking.schema.json. No I/O, no external state — all reproducibility
 * lives in this module having no dependency beyond its inputs.
 */

export const RANKING_METHODOLOGY_VERSION = 'RANK-1.0'

/** Below this many metric-eligible journals, a category gets no quartiles at all. */
export const MIN_CATEGORY_SIZE = 20

/**
 * @param {{ journal_id: string, pci: number }[]} entries - one per metric-eligible
 *   journal in a single PSC category for a single metric_year. Journals with
 *   a null/undefined PCI must be filtered out by the caller before this runs
 *   (they are not part of category_size).
 * @param {{ category_code: string, metric_year: number }} context
 * @returns {object[]} ranking records per schema/ranking.schema.json
 */
export function rankCategory(entries, { category_code, metric_year }) {
  const category_size = entries.length

  if (category_size < MIN_CATEGORY_SIZE) {
    return entries.map(e => ({
      journal_id: e.journal_id,
      category_code,
      metric_year,
      rank: null,
      rank_mid: null,
      category_size,
      percentile: null,
      quartile: null,
      ranking_method: 'unavailable',
      tied_with: [],
      methodology_version: RANKING_METHODOLOGY_VERSION,
    }))
  }

  // Sort descending by PCI. Stable sort keeps input order among exact ties,
  // which mid-rank grouping below then resolves fairly regardless of that order.
  const sorted = [...entries].sort((a, b) => b.pci - a.pci)

  // Group into tie-blocks of identical PCI, each block sharing one mid-rank.
  const blocks = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j].pci === sorted[i].pci) j++
    blocks.push(sorted.slice(i, j))
    i = j
  }

  const records = []
  let position = 1 // 1-based rank position of the first item in the current block
  for (const block of blocks) {
    const blockSize = block.length
    // Mid-rank: average of the rank positions this tied block occupies.
    // E.g. a 3-way tie occupying positions 5,6,7 gets rank_mid = 6.
    const rankMid = position + (blockSize - 1) / 2
    const percentile = 100 * (category_size - rankMid + 0.5) / category_size
    const quartile = toQuartile(percentile)
    const tiedIds = block.map(e => e.journal_id)

    for (const entry of block) {
      records.push({
        journal_id: entry.journal_id,
        category_code,
        metric_year,
        rank: position, // conventional competition rank: 1, 2, 2, 4, 5, ... (tied entries share the block's starting position)
        rank_mid: Math.round(rankMid * 100) / 100, // fractional mid-rank, percentile-formula input only — e.g. 6 or 6.5
        category_size,
        percentile: Math.round(percentile * 100) / 100,
        quartile,
        ranking_method: 'pci_midrank',
        tied_with: tiedIds.filter(id => id !== entry.journal_id),
        methodology_version: RANKING_METHODOLOGY_VERSION,
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
