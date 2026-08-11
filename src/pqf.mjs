/**
 * PQF (POSI Qualification Framework) — Core Collection ADMISSION ONLY.
 * Implements the "POSI Journal Evaluation & Ranking Framework 1.0" PQF
 * section.
 *
 * "PQF answers only 'does this journal get into the Core Collection?' —
 * never 'where does it rank against peers.'" Public PQF output must be
 * exactly one of: Eligible, Review Required, Insufficient Evidence, Not
 * Eligible — never "PQF Q1", "PQF Ranking", or an "A+ Journal"-style
 * label. This module has no code path that can PRODUCE any output outside
 * that four-value enum — see PQF_STATUSES and determinePqfStatus()'s
 * return type.
 *
 * No prior PQF implementation existed in posi-engine (only a `pqf`
 * numeric field on the posi-data corpus's legacy website-repo-sourced
 * records, out of scope here — see corpus/README.md). This is a new,
 * intentionally minimal module: it does not re-derive admission criteria
 * (that's PJR-SPEC.md/Editorial Selection methodology's job, still to be
 * migrated into posi-engine as a separate, larger task) — it only encodes
 * the OUTPUT CONTRACT the framework requires (the four-value enum) on top
 * of already-computed Evidence Coverage + integrity inputs, so any future
 * admission-scoring code has one canonical, narrow place to render its
 * final public status through, and cannot accidentally leak a ranking-
 * shaped label.
 *
 * Pure function, no I/O.
 */

export const PQF_METHODOLOGY_VERSION = 'PQF-1.0'

/** The ONLY four values PQF may ever publicly output. No other string may
 * ever be returned by determinePqfStatus() — see its implementation. */
export const PQF_STATUSES = Object.freeze(['Eligible', 'Review Required', 'Insufficient Evidence', 'Not Eligible'])

/**
 * @param {{
 *   evidenceCoveragePercent: number,
 *   mandatoryEvidenceResolved: boolean,
 *   hasUnresolvedSevereIntegrityFinding: boolean,
 *   reviewFlagged: boolean,
 * }} input
 * @returns {'Eligible'|'Review Required'|'Insufficient Evidence'|'Not Eligible'}
 */
export function determinePqfStatus(input) {
  const { evidenceCoveragePercent, mandatoryEvidenceResolved, hasUnresolvedSevereIntegrityFinding, reviewFlagged } = input

  if (!mandatoryEvidenceResolved || evidenceCoveragePercent < 60) {
    return 'Insufficient Evidence'
  }
  if (hasUnresolvedSevereIntegrityFinding) {
    return 'Not Eligible'
  }
  if (reviewFlagged || evidenceCoveragePercent < 80) {
    return 'Review Required'
  }
  return 'Eligible'
}

/**
 * Defensive validator: given some other code path's PQF-labeled output
 * (e.g. legacy data being migrated), flags anything that isn't one of the
 * four allowed values or that looks like a ranking-shaped label
 * ("PQF Q1", "A+ Journal", "PQF Ranking: ...") so it can be caught and
 * corrected rather than displayed.
 * @param {string} label
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function validatePqfPublicLabel(label) {
  if (PQF_STATUSES.includes(label)) return { valid: true, reason: null }
  const looksLikeRanking = /\bQ[1-4]\b|ranking|grade|\bA\+|\btier\b/i.test(label ?? '')
  return {
    valid: false,
    reason: looksLikeRanking
      ? `"${label}" looks like a ranking/grade label — PQF is admission-only and must never output a rank, quartile, or grade`
      : `"${label}" is not one of the four allowed PQF statuses: ${PQF_STATUSES.join(', ')}`,
  }
}
