/**
 * ISSN integrity of posi-data's journal records. Pure functions; no I/O.
 *
 * Two problems are reported:
 *   - an ISSN whose check digit is wrong;
 *   - an ISSN carried by two journals that are both still live (a superseded id
 *     legitimately shares ISSNs with the id that replaced it).
 *
 * Nothing is corrected here. A finding is either listed in posi-data's review
 * queue (audits/data-quality/issn-integrity/open-issues.csv), where a person
 * decides it, or it is new and fails validation.
 */
import { issnChecksumValid } from './migration/normalize.mjs'

const FIELDS = ['issn_l', 'issn_print', 'issn_online']

/**
 * @param {{ id: string, identifiers?: Record<string, string|null> }[]} records
 * @param {Set<string>} superseded ids that have been replaced by another id
 * @returns {{ kind: 'checksum'|'shared', issn: string, ids: string[], field?: string }[]}
 */
export function issnIntegrityFindings(records, superseded = new Set()) {
  const out = []
  const holders = new Map()
  for (const r of records) {
    for (const f of FIELDS) {
      const v = r.identifiers?.[f]
      if (!v) continue
      if (!issnChecksumValid(v)) out.push({ kind: 'checksum', issn: v, ids: [r.id], field: f })
      if (superseded.has(r.id)) continue
      const s = holders.get(v) ?? new Set()
      s.add(r.id)
      holders.set(v, s)
    }
  }
  for (const [issn, ids] of holders) if (ids.size > 1) out.push({ kind: 'shared', issn, ids: [...ids].sort() })
  return out
}

/** Stable key used to match a finding against the review queue. */
export function findingKey(f) {
  return `${f.kind}:${f.issn}:${f.ids.join('+')}`
}

/** Parse the review queue's CSV (columns: kind,issn,posi_ids,...); posi_ids are space-separated. */
export function parseOpenIssues(csv) {
  const keys = new Set()
  for (const line of csv.split('\n').slice(1)) {
    const m = /^([a-z]+),([0-9X-]+),"?([^",]+)"?/.exec(line.trim())
    if (m) keys.add(`${m[1]}:${m[2]}:${m[3].trim().split(/\s+/).sort().join('+')}`)
  }
  return keys
}
