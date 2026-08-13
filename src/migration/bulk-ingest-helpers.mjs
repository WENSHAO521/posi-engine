/**
 * Shared helpers for the one-off bulk-ingestion scripts (Elsevier
 * jnlactive.csv, Frontiers title list, and any future one) that add new
 * Global Benchmark records from a publisher-provided CSV enriched via
 * OpenAlex. Extracted here (rather than duplicated per script) after a
 * review found the same three defects in both ingest-jnlactive-
 * elsevier-2026.mjs and ingest-frontiers-2026.mjs, since both were written
 * from the same template.
 */

/**
 * A benchmark record can carry issn_print, issn_online, and/or the
 * kind-unspecified `issn` field (see buildRecord()'s own comment in each
 * ingest script for why a bulk-publisher-catalog ISSN column with no
 * explicit print/online marking is never written into issn_online).
 * Indexing on only one of them (e.g. `r.issn_online || r.issn_print`)
 * means a CSV row bearing a different one of the three looks "new" even
 * though the journal is already in the benchmark -- this collects all.
 * @param {{ issn_online?: string|null, issn_print?: string|null, issn?: string|null }[]} benchmarkRecords
 * @returns {Set<string>}
 */
export function buildExistingIssnSet(benchmarkRecords) {
  return new Set(benchmarkRecords.flatMap(r => [r.issn_online, r.issn_print, r.issn]).filter(Boolean))
}

/**
 * OpenAlex's own `country_code` field is documented as ISO 3166-1 alpha-2
 * and is normally already clean, but this ingestion pipeline has been
 * burned before by trusting an upstream field's documented shape without
 * checking it (see parseFrontiersCsv()'s ISSN-format validation, added
 * after a "Coming Soon" placeholder almost got written into issn_online).
 * Defensive, not redundant: a malformed or unexpected value is dropped to
 * `null` rather than silently written into a field the website displays
 * as a country.
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function validateIsoCountryCode(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : null
}

/**
 * @param {string} rawValue - the raw --concurrency CLI arg
 * @returns {number}
 * @throws if not a positive integer -- a bad value (e.g. "0") would
 *   otherwise make the batching loop's `i += concurrency` never advance.
 */
export function validateConcurrency(rawValue) {
  const n = parseInt(rawValue, 10)
  if (!Number.isInteger(n) || String(n) !== String(rawValue).trim() || n < 1) {
    throw new Error(`--concurrency must be a positive integer, got: ${rawValue}`)
  }
  return n
}

/**
 * @param {{ identity_type: string, identity_value: string, reason: string }[]} rows -- registry/excluded-identities.csv
 * @returns {Set<string>} the set of excluded identity_value strings (ISSNs, etc.)
 */
export function buildExcludedIdentitySet(rows) {
  return new Set(rows.map(r => r.identity_value))
}

/**
 * Splits OpenAlex lookup results into ones safe to persist as a new
 * benchmark record (a definitive answer: found, or genuinely not found)
 * versus transient failures (rate limited, server error, timeout, network
 * error) that must NOT be turned into a permanent record -- doing so would
 * write openalex_source_id=null/article_count=0 indistinguishably from a
 * real absence, silently mistaking "OpenAlex was unreachable right now"
 * for "this journal genuinely isn't in OpenAlex."
 * @param {{ result: { status: number|null } }[]} lookups
 * @returns {{ ingestable: object[], transientErrors: object[] }}
 */
export function partitionOpenAlexLookups(lookups) {
  const ingestable = lookups.filter(l => l.result.status === 200 || l.result.status === 404)
  const transientErrors = lookups.filter(l => l.result.status !== 200 && l.result.status !== 404)
  return { ingestable, transientErrors }
}
