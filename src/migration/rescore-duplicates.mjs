/**
 * Re-scores dedupe.mjs's possible_duplicates using OpenAlex enrichment
 * verdicts — scoring only, never auto-merges the underlying candidate
 * entities (see dedupe.mjs's "conflict beats match" principle, which
 * applies here too: OpenAlex agreement is strong evidence, not an
 * automatic merge instruction).
 */

/**
 * @param {{ title: string, publisher: string, legacy_ids: string[], candidate_entities: string[] }} group
 * @param {Map<string, { status: string, sources: object[] }>} enrichmentByCandidateId
 * @returns {object} group with an added `rescoring` verdict
 */
export function rescorePossibleDuplicate(group, enrichmentByCandidateId) {
  const verdicts = group.candidate_entities.map(id => enrichmentByCandidateId.get(id))

  if (verdicts.some(v => !v)) {
    return { ...group, rescoring: 'manual_review' } // missing enrichment data entirely
  }

  const resolvable = verdicts.filter(v => v.status === 'verified' || v.status === 'partial_match')
  if (resolvable.length < verdicts.length) {
    return { ...group, rescoring: 'manual_review' }
  }

  const sourceIds = new Set(resolvable.flatMap(v => v.sources.map(s => s.id)).filter(Boolean))
  const issnLs = new Set(resolvable.flatMap(v => v.sources.map(s => s.issn_l)).filter(Boolean))

  if (sourceIds.size === 1) {
    return { ...group, rescoring: 'openalex_confirms_same' }
  }
  if (sourceIds.size > 1 && issnLs.size <= 1) {
    // Different source ids but OpenAlex itself agrees on one ISSN-L (or has
    // no ISSN-L opinion) — treat as still-ambiguous rather than confidently distinct.
    return { ...group, rescoring: 'manual_review' }
  }
  if (sourceIds.size > 1) {
    return { ...group, rescoring: 'openalex_confirms_distinct' }
  }
  return { ...group, rescoring: 'manual_review' }
}

export function rescoreAll(possibleDuplicates, enrichmentByCandidateId) {
  return possibleDuplicates.map(g => rescorePossibleDuplicate(g, enrichmentByCandidateId))
}
