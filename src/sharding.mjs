/**
 * Shard-path computation — implements posi-data/PJR-SPEC.md § 4:
 * `journals/`, `metrics/`, `rankings/` are sharded by "the last byte of the
 * journal id's hash", a 2-character lowercase hex prefix (00-ff, 256
 * shards). Pure function, no I/O — callers join this onto whatever base
 * directory they're writing into.
 */

import { createHash } from 'node:crypto'

/**
 * @param {string} journalId - e.g. "POSI-J-000123"
 * @returns {string} 2-character lowercase hex shard, derived from the LAST
 *   byte of the id's SHA-1 digest (not the first — using the last byte
 *   specifically avoids any shard skew from POSI-J ids sharing a long
 *   common numeric prefix as they're minted sequentially; SHA-1 is used
 *   only as a deterministic, evenly-distributing hash here, not for any
 *   security property).
 */
export function shardFor(journalId) {
  const digest = createHash('sha1').update(journalId).digest('hex')
  return digest.slice(-2)
}

/** @returns {string} "journals/core/<shard>/<journalId>.json" */
export function journalCorePath(journalId) {
  return `journals/core/${shardFor(journalId)}/${journalId}.json`
}

/** @returns {string} "metrics/<metricYear>/<shard>/<journalId>.json" */
export function metricPath(journalId, metricYear) {
  return `metrics/${metricYear}/${shardFor(journalId)}/${journalId}.json`
}

/** @returns {string} "rankings/<metricYear>/<shard>/<journalId>.json" */
export function rankingPath(journalId, metricYear) {
  return `rankings/${metricYear}/${shardFor(journalId)}/${journalId}.json`
}
