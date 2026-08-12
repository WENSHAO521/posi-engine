/**
 * registry/superseded-ids.csv support -- see posi-data's registry/README.md
 * and PJR-SPEC.md §12. A superseded id is never mutated or removed from
 * journal-id-map.csv (registry rows are permanent); this module is the
 * resolver-side follow-through so an old identity value that still maps to
 * a superseded id in the registry resolves to the SURVIVING id instead,
 * rather than silently reviving a retired identity.
 */

/**
 * @param {{ old_posi_id: string, superseded_by_posi_id: string }[]} rows
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSupersessionRows(rows, { knownPosiIds = null } = {}) {
  const errors = []
  const seenOld = new Map() // old_posi_id -> count
  const targets = new Set(rows.map(r => r.superseded_by_posi_id))

  for (const row of rows) {
    if (row.old_posi_id === row.superseded_by_posi_id) {
      errors.push(`self-supersession: ${row.old_posi_id} superseded by itself`)
    }
    seenOld.set(row.old_posi_id, (seenOld.get(row.old_posi_id) ?? 0) + 1)
    if (knownPosiIds && !knownPosiIds.has(row.superseded_by_posi_id)) {
      errors.push(`superseded_by_posi_id does not exist in the registry: ${row.superseded_by_posi_id} (from ${row.old_posi_id})`)
    }
  }

  for (const [oldId, count] of seenOld) {
    if (count > 1) errors.push(`duplicate old_posi_id (must appear at most once): ${oldId}`)
  }

  // No chains: a row's superseded_by_posi_id must never itself be another
  // row's old_posi_id. If a second supersession is ever needed, the fix is
  // to flatten it at write time (A -> C, B -> C), not to chain (A -> B -> C).
  for (const row of rows) {
    if (seenOld.has(row.superseded_by_posi_id)) {
      errors.push(`chain detected (not allowed -- flatten instead): ${row.old_posi_id} -> ${row.superseded_by_posi_id} -> ...`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/** @returns {Map<string,string>} old_posi_id -> superseded_by_posi_id */
export function buildSupersessionMap(rows) {
  return new Map(rows.map(r => [r.old_posi_id, r.superseded_by_posi_id]))
}

/**
 * Follows the supersession chain (defensively, even though
 * validateSupersessionRows() forbids chains at write time) to the final
 * surviving id. Guards against a cycle slipping through validation by
 * capping iterations rather than looping forever.
 * @param {string} posiId
 * @param {Map<string,string>} supersessionMap
 * @returns {string} the surviving posi_id (== posiId if it was never superseded)
 */
export function resolveSupersededId(posiId, supersessionMap) {
  let current = posiId
  const visited = new Set([current])
  for (let i = 0; i < supersessionMap.size + 1; i++) {
    const next = supersessionMap.get(current)
    if (!next) return current
    if (visited.has(next)) throw new Error(`Cycle detected in supersession chain starting at ${posiId}`)
    visited.add(next)
    current = next
  }
  throw new Error(`Supersession chain from ${posiId} exceeded expected length -- likely a cycle`)
}

/**
 * Rewrites every posi_id value in a value->posi_id index (e.g.
 * mint.mjs's buildRegistryIndex() output, or remap's own value index) so
 * that any value currently pointing at a superseded id resolves straight
 * through to the surviving id instead.
 * @param {Map<string,string>} valueIndex
 * @param {Map<string,string>} supersessionMap
 * @returns {Map<string,string>} a new Map, valueIndex is not mutated
 */
export function applySupersessionForwarding(valueIndex, supersessionMap) {
  if (supersessionMap.size === 0) return valueIndex
  const forwarded = new Map()
  for (const [key, posiId] of valueIndex) {
    forwarded.set(key, resolveSupersededId(posiId, supersessionMap))
  }
  return forwarded
}

/**
 * The actual resolver follow-through: `registry/journal-id-map.csv` rows
 * -> identity_value -> posi_id index, with every posi_id already forwarded
 * through registry/superseded-ids.csv. This is what
 * remap-benchmark-identity-2026.mjs's lookup runs against, so
 * `resolve(old ISSN) -> old posi_id -> follow superseded_by -> surviving
 * posi_id` (not `resolve(old ISSN) -> old posi_id`, full stop) is exactly
 * what a caller gets back -- the forwarding happens at index-build time,
 * not as a separate step a caller could forget.
 * @param {{ posi_id: string, identity_type: string, identity_value: string }[]} registryRows
 * @param {Map<string,string>} supersessionMap
 * @returns {Map<string, { posi_id: string, identity_type: string }[]>}
 */
export function buildForwardedValueIndex(registryRows, supersessionMap = new Map()) {
  const idx = new Map()
  for (const row of registryRows) {
    if (!idx.has(row.identity_value)) idx.set(row.identity_value, [])
    const posiId = supersessionMap.size > 0 ? resolveSupersededId(row.posi_id, supersessionMap) : row.posi_id
    idx.get(row.identity_value).push({ posi_id: posiId, identity_type: row.identity_type })
  }
  return idx
}
