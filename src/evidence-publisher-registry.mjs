/**
 * Publisher Evidence Registry — AJR-SPEC.md § 8. Where a publisher
 * explicitly states a policy's scope covers all its journals, POSI can
 * verify that once and let every journal within the stated scope inherit
 * it, instead of re-crawling the same publisher-wide policy per journal.
 *
 * This module is the inheritance MECHANISM only. It ships with zero
 * populated registry entries: AJR-SPEC.md § 8/§ 13 itself leaves "who
 * verifies a publisher-wide policy's stated scope, and how is a dispute
 * resolved" as an open governance question, not yet answered. Populating
 * a real entry means a person has actually checked a publisher's stated
 * policy and its scope -- that has not happened for this Evidence ETL v1
 * run, so every journal in this run is resolved purely from its own
 * crawled evidence, which is the safe default until a real, verified
 * entry exists.
 */

/** Only these criterion ids may ever be filled from a publisher-level
 * entry (AJR-SPEC.md § 8: "inheritable" list) -- inherently
 * journal-specific items (editorial board, peer-review model, aims &
 * scope, publication frequency, journal-specific APC amount) can never be
 * satisfied this way, no matter what a publisher registry entry claims. */
export const INHERITABLE_CRITERION_IDS = Object.freeze([
  'publication_ethics',
  'corrections_retractions',
  'authorship_policy',
  'coi_policy',
  'ai_use_policy',
  'data_availability',
])

/**
 * @typedef {{
 *   publisher: string,
 *   policy_type: string,        // must be one of INHERITABLE_CRITERION_IDS
 *   scope: 'all_journals',
 *   evidence_url: string,
 *   verified_by: string,        // who confirmed the stated scope
 *   verified_at: string,        // ISO date
 * }} PublisherRegistryEntry
 */

/**
 * @param {ReturnType<typeof import('./evidence-resolver.mjs').resolveCriterion>[]} journalItems
 * @param {string} publisherName
 * @param {PublisherRegistryEntry[]} registry - the full publisher registry
 *   (typically loaded from posi-data's evidence/publishers/*.json).
 * @returns {ReturnType<typeof import('./evidence-resolver.mjs').resolveCriterion>[]}
 *   journalItems with any gap (status unknown/blocked -- never a
 *   journal-level not_met, which is a real resolved answer and must never
 *   be silently overwritten) filled from a matching, verified,
 *   inheritable publisher entry. Everything else passes through
 *   unchanged.
 */
export function applyPublisherInheritance(journalItems, publisherName, registry) {
  if (!publisherName || !registry?.length) return journalItems

  const applicableEntries = registry.filter(
    e => e.publisher === publisherName && e.scope === 'all_journals' && INHERITABLE_CRITERION_IDS.includes(e.policy_type)
  )
  if (applicableEntries.length === 0) return journalItems

  const byPolicyType = new Map(applicableEntries.map(e => [e.policy_type, e]))

  return journalItems.map(item => {
    if (item.status !== 'unknown' && item.status !== 'blocked') return item // never override a resolved answer
    const entry = byPolicyType.get(item.id)
    if (!entry) return item
    return {
      ...item,
      status: 'met',
      source_url: entry.evidence_url,
      retrieved_at: entry.verified_at,
      inherited_from_publisher: entry.publisher,
    }
  })
}
