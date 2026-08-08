/**
 * Identity signal extraction — posi-data/registry/README.md's priority
 * order, minus title/publisher (those are candidate_duplicate evidence
 * only, handled in dedupe.mjs, never an identity match here).
 */

/**
 * @param {object} normalized - output of normalize.mjs's normalizeRecord().normalized
 * @returns {{
 *   issnSet: string[],       // deduplicated set of valid ISSNs this record carries (issn_l ∪ issn_print ∪ issn_online)
 *   hasIssnL: boolean,
 *   openalexId: string | null,
 *   doajId: string | null,
 * }}
 */
export function extractIdentitySignals(normalized) {
  const issns = new Set()
  if (normalized.issn_l) issns.add(normalized.issn_l)
  if (normalized.issn_print) issns.add(normalized.issn_print)
  if (normalized.issn_online) issns.add(normalized.issn_online)

  return {
    issnSet: [...issns].sort(),
    hasIssnL: !!normalized.issn_l,
    openalexId: normalized.openalex_source_id ?? null,
    doajId: normalized.doaj_id ?? null,
  }
}

/**
 * Highest-priority single identity for registry lookup purposes (posi-data/
 * registry/README.md's priority order). Used for reporting/display only —
 * dedupe.mjs's union-find uses the full signal set (extractIdentitySignals),
 * not just this single top pick, so it can still connect two records that
 * matched on a lower-tier signal.
 * @returns {{ tier: 'issn_l' | 'issn_pair' | 'openalex' | 'doaj_id' | 'unresolved', key: string | null }}
 */
export function primaryIdentity(signals) {
  if (signals.hasIssnL) {
    return { tier: 'issn_l', key: signals.issnSet[0] }
  }
  if (signals.issnSet.length > 0) return { tier: 'issn_pair', key: signals.issnSet.join('/') }
  if (signals.openalexId) return { tier: 'openalex', key: signals.openalexId }
  if (signals.doajId) return { tier: 'doaj_id', key: signals.doajId }
  return { tier: 'unresolved', key: null }
}
