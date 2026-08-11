/**
 * International Reach — DESCRIPTIVE ONLY, NEVER SCORED. Implements the
 * "POSI Journal Evaluation & Ranking Framework 1.0" International Reach
 * section and posi-data/PJR-SPEC.md § 6's existing rule (already the
 * `international` block in schema/metric.schema.json).
 *
 * "Scoring this would unfairly penalize legitimately regional-scope
 * journals — local law, local history, regional-language scholarship."
 * This module computes exactly the five display fields PJR-SPEC.md § 6
 * already names (author_countries, citing_countries,
 * international_collaboration_share, international_citation_share,
 * largest_author_country_share) and NOTHING ELSE — no score, no tier, no
 * quartile contribution. It does not import, and is not imported by, any
 * of ajr-early-stage.mjs / ajr-mature.mjs / quartile-tracks.mjs /
 * ranking.mjs / pci.mjs (verified by test/international-reach.test.mjs's
 * dependency-boundary check) — the only way this data reaches a reader is
 * via direct display, never via a scoring pipeline.
 *
 * Pure functions, no I/O.
 */

export const INTERNATIONAL_REACH_METHODOLOGY_VERSION = 'INTL-1.0'

/**
 * @param {{ country: string|null }[]} authors - every author across a
 *   journal's sampled/known output, one entry per author-occurrence
 *   (repeated authors counted each time they appear, matching how
 *   `largest_author_country_share` is meant to read — "share of authored
 *   output", not "share of unique people").
 * @param {string} homeCountry - the journal's own registered/publisher country (ISO 3166-1 alpha-2)
 * @returns {{
 *   author_countries: number,
 *   international_collaboration_share: number|null,
 *   largest_author_country_share: number|null,
 * }}
 */
export function computeAuthorCountryFields(authors, homeCountry) {
  const withCountry = (authors ?? []).filter(a => a.country)
  const distinctCountries = new Set(withCountry.map(a => a.country))
  const authorCountries = distinctCountries.size

  if (withCountry.length === 0) {
    return { author_countries: 0, international_collaboration_share: null, largest_author_country_share: null }
  }

  const foreignCount = withCountry.filter(a => a.country !== homeCountry).length
  const internationalCollaborationShare = round4(foreignCount / withCountry.length)

  const counts = new Map()
  for (const a of withCountry) counts.set(a.country, (counts.get(a.country) ?? 0) + 1)
  const largestCount = Math.max(...counts.values())
  const largestAuthorCountryShare = round4(largestCount / withCountry.length)

  return {
    author_countries: authorCountries,
    international_collaboration_share: internationalCollaborationShare,
    largest_author_country_share: largestAuthorCountryShare,
  }
}

/**
 * @param {{ citing_country: string|null }[]} citations - citation edges with a resolved citing-country
 * @param {string} homeCountry
 * @returns {{ citing_countries: number, international_citation_share: number|null }}
 */
export function computeCitingCountryFields(citations, homeCountry) {
  const withCountry = (citations ?? []).filter(c => c.citing_country)
  const distinctCountries = new Set(withCountry.map(c => c.citing_country))
  if (withCountry.length === 0) {
    return { citing_countries: distinctCountries.size, international_citation_share: null }
  }
  const foreignCount = withCountry.filter(c => c.citing_country !== homeCountry).length
  return {
    citing_countries: distinctCountries.size,
    international_citation_share: round4(foreignCount / withCountry.length),
  }
}

/**
 * Assembles the full display-only block, matching
 * schema/metric.schema.json's `international` shape exactly.
 * @returns {{ author_countries: number, citing_countries: number, international_collaboration_share: number|null, international_citation_share: number|null, largest_author_country_share: number|null }}
 */
export function buildInternationalReachBlock({ authors, citations, homeCountry }) {
  const authorFields = computeAuthorCountryFields(authors, homeCountry)
  const citingFields = computeCitingCountryFields(citations, homeCountry)
  return {
    author_countries: authorFields.author_countries,
    citing_countries: citingFields.citing_countries,
    international_collaboration_share: authorFields.international_collaboration_share,
    international_citation_share: citingFields.international_citation_share,
    largest_author_country_share: authorFields.largest_author_country_share,
  }
}

function round4(n) { return Math.round(n * 10000) / 10000 }
