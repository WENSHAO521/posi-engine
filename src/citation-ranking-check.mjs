/**
 * Invariants every POSI Citation Ranking edition must satisfy
 * (posi-data/POSI-EVAL-1.0-SPEC.md § 17). Run by check-edition.mjs before an
 * edition is released, and mirrored by the website's build-time check.
 * Returns a list of problems; empty means the edition is consistent.
 */
import { calculateCitationQuartile, calculatePOSIZone, CITATION_RANKING_STATUS, RANKING_THRESHOLDS } from './evaluation.mjs'

export function validateCitationEdition(records) {
  const problems = []
  const tieKey = new Map()
  for (const r of records) {
    const id = r.journal_id
    if (!CITATION_RANKING_STATUS.includes(r.citation_ranking_status)) problems.push(`${id}: unknown status ${r.citation_ranking_status}`)
    if (r.citation_quartile != null && !['Q1', 'Q2', 'Q3', 'Q4'].includes(r.citation_quartile)) problems.push(`${id}: invalid quartile ${r.citation_quartile}`)
    const ranked = r.citation_rank != null
    if (r.citation_ranking_status === 'official') {
      for (const k of ['pnci', 'ranking_category_id', 'citation_rank', 'citation_percentile', 'citation_quartile']) {
        if (r[k] == null) problems.push(`${id}: official ranking without ${k}`)
      }
      if ((r.citation_rank_total ?? 0) >= RANKING_THRESHOLDS.categoryOfficialZone && (r.posi_zone == null || r.zone_status !== 'official')) {
        problems.push(`${id}: category of ${r.citation_rank_total} without an official zone`)
      }
    }
    if (!['official', 'provisional'].includes(r.citation_ranking_status) && (ranked || r.citation_quartile || r.posi_zone)) {
      problems.push(`${id}: ${r.citation_ranking_status} journal carries a rank, quartile or zone`)
    }
    if (r.citation_percentile != null) {
      if (r.citation_quartile !== calculateCitationQuartile(r.citation_percentile)) problems.push(`${id}: quartile ${r.citation_quartile} disagrees with percentile ${r.citation_percentile}`)
      if (r.posi_zone != null && r.posi_zone !== calculatePOSIZone(r.citation_percentile)) problems.push(`${id}: zone ${r.posi_zone} disagrees with percentile ${r.citation_percentile}`)
    }
    if (ranked) {
      const k = `${r.ranking_category_id}|${r.pnci}`
      const prev = tieKey.get(k)
      if (prev && (prev.citation_rank !== r.citation_rank || prev.citation_percentile !== r.citation_percentile)) problems.push(`${id}: tied PNCI with ${prev.journal_id} but a different rank`)
      tieKey.set(k, r)
    }
  }
  return problems
}
