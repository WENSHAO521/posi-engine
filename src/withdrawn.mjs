/**
 * Withdrawn journals. A journal taken out of the database after admission
 * keeps its record in posi-data's corpus (its POSI-J-###### id and history
 * stay) with `collection_status: 'withdrawn'`. The crawls and ratings skip
 * it: nothing can be evidenced or rated for a journal that has been
 * withdrawn (the one so far had no DOIs registered), and a monthly crawl of
 * it is wasted work and an extra record in every report.
 */

/** @param {{ collection_status?: string|null }|null|undefined} journal */
export function isWithdrawn(journal) {
  return journal?.collection_status === 'withdrawn'
}

/**
 * The journals still in the database, logging how many were left out.
 * @template T
 * @param {T[]} journals
 * @param {string} [what]
 * @returns {T[]}
 */
export function withoutWithdrawn(journals, what = 'corpus') {
  const kept = journals.filter(j => !isWithdrawn(j))
  if (kept.length < journals.length) console.log(`  ${what}: skipping ${journals.length - kept.length} withdrawn journal(s)`)
  return kept
}
