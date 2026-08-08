/**
 * PSC classification suggester — implements posi-data/PJR-SPEC.md § 10.
 *
 * STUB. Intended contract: analyze a journal's recent article topic
 * distribution (from OpenAlex Topics or an equivalent open taxonomy feed)
 * and suggest a primary + up to 2 secondary PSC category, for a POSI
 * Subject Editor to confirm or override — never auto-applied to a journal
 * record without human confirmation (see journal.schema.json's
 * classification.assigned_by enum: 'ml_suggested_pending_review' is a
 * distinct, non-final state from 'posi_subject_editor').
 */

/**
 * @param {{ topic: string, share: number }[]} topicDistribution - e.g.
 *   [{ topic: 'Public Health', share: 0.32 }, ...], shares summing to ~1.0
 * @param {object} pscTaxonomy - parsed taxonomy/psc/current.json contents
 * @returns {{ primary: string, secondary: string[], confidence: number }}
 */
export function suggestClassification(topicDistribution, pscTaxonomy) {
  throw new Error('not implemented — needs a real topic-to-PSC-code mapping, ' +
    'built once posi-data has journal/work records with topic data to train against')
}
