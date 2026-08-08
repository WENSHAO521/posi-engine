/**
 * Citation integrity checks — implements posi-data/PJR-SPEC.md § 9.
 *
 * STUB. Intended checks, each returning a flag (not an automatic suppression —
 * flags feed a review queue; suppression is applied to metric.schema.json's
 * status/suppression_reason fields only after review):
 *   - selfCitationRate(journalWorks, journalId)
 *   - citationStacking(citationEdges) — abnormal pairwise journal A<->B citing
 *   - citationConcentration(journalWorks) — few articles driving most citations
 *   - publisherCitationCluster(citationEdges, publisherMap)
 *   - suddenCitationSpike(metricHistory)
 *   - citationCartel(citationEdges) — graph-cycle detection across journal clusters
 *
 * None of these are implemented yet — there's no citation-edge data in
 * posi-data to run them against.
 */

export function selfCitationRate() {
  throw new Error('not implemented — needs citation edge data from posi-data')
}
