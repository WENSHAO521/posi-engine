/**
 * Cross-check logic: does ShowJCR's plain identity data (journal name /
 * ISSN / EISSN — see extract.mjs's header for what is and isn't pulled
 * from ShowJCR) agree with POSI's own OpenAlex-derived journal records?
 *
 * Pure functions only, no I/O — scripts/cross-check-showjcr-identity.mjs
 * owns fetching both sides and writing the report.
 */

import { normalizeIssn } from '../migration/normalize.mjs'

/** Canonical XXXX-XXXX form for matching, or null if unparseable. Doesn't
 * require a valid checksum — a checksum-invalid ISSN can still be the
 * "same" typo on both sides, and checksum validation is normalize.mjs's
 * job for POSI's own records, not this cross-check's. */
function canonicalIssn(raw) {
  if (!raw) return null
  return normalizeIssn(raw).value
}

/**
 * Loose title match: lowercase, spell out "&" as "and", strip punctuation,
 * collapse whitespace. Deliberately coarser than normalize.mjs's
 * normalizeTitle (which preserves case/punctuation for storage) — this is
 * for "are these plausibly the same journal name", not for storage.
 */
export function foldTitle(title) {
  if (!title) return ''
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics (post-NFKD combining marks)
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Unicode-aware: keeps letters/digits from any script (Chinese journal
    // names in CCFT/CCF included), not just ASCII — a plain [a-z0-9] class
    // would silently fold every CJK title down to an empty string.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Many real, unrelated journals from different countries/publishers share
 * a short generic English title — "Politics", "Area", "Sophia", "Spectrum",
 * "Society" all exist multiple times over in practice. A title-only match
 * on one of these is much more likely to be a coincidental collision than
 * a genuine identity error, so callers should treat it with less
 * confidence than a multi-word, distinctive title match.
 */
function isGenericShortTitle(foldedTitle) {
  return foldedTitle.split(' ').filter(Boolean).length <= 2
}

/**
 * @param {{ id: string, title: string, issn_l: string|null, issn_print: string|null, issn_online: string|null }[]} posiRecords
 * @returns {{ byIssn: Map<string, object[]>, byTitle: Map<string, object[]> }}
 */
export function buildPosiIndex(posiRecords) {
  const byIssn = new Map()
  const byTitle = new Map()
  for (const rec of posiRecords) {
    for (const raw of [rec.issn_l, rec.issn_print, rec.issn_online]) {
      const issn = canonicalIssn(raw)
      if (!issn) continue
      if (!byIssn.has(issn)) byIssn.set(issn, [])
      byIssn.get(issn).push(rec)
    }
    const key = foldTitle(rec.title)
    if (!key) continue
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push(rec)
  }
  return { byIssn, byTitle }
}

function dedupeById(records) {
  const byId = new Map()
  for (const r of records) byId.set(r.id, r)
  return [...byId.values()]
}

/**
 * Cross-checks an ISSN-bearing ShowJCR family (JCR, CAS partition,
 * rising-star) against POSI's identity index.
 *
 * @param {{ journal: string, issn: string|null, eissn: string|null }[]} records
 * @param {{ byIssn: Map, byTitle: Map }} posiIndex
 * @param {string} family - family name, stamped onto every result row
 * @returns {{
 *   titleMismatches: object[],  // ISSN matched a POSI record, but titles disagree
 *   issnMismatches: object[],   // title matched a POSI record, but no ISSN in common —
 *                                  each carries a `confidence` field ('normal' or
 *                                  'low_generic_title' for short/generic titles like
 *                                  "Politics" or "Area" that plausibly collide across
 *                                  unrelated journals by coincidence)
 *   notFound: object[],         // neither ISSN nor title matched anything in POSI
 *   matchedCount: number,       // ISSN matched and titles agree — not reported in detail
 * }}
 */
export function crossCheckIssnFamily(records, posiIndex, family) {
  const titleMismatches = []
  const issnMismatches = []
  const notFound = []
  let matchedCount = 0

  for (const rec of records) {
    const issns = [canonicalIssn(rec.issn), canonicalIssn(rec.eissn)].filter(Boolean)
    let posiHits = []
    for (const issn of issns) posiHits.push(...(posiIndex.byIssn.get(issn) ?? []))
    posiHits = dedupeById(posiHits)

    if (posiHits.length > 0) {
      const foldedShowjcr = foldTitle(rec.journal)
      for (const posiRec of posiHits) {
        if (foldTitle(posiRec.title) === foldedShowjcr) {
          matchedCount++
        } else {
          titleMismatches.push({
            family,
            type: 'title_mismatch_on_issn_match',
            showjcr_journal: rec.journal,
            showjcr_issn: rec.issn,
            showjcr_eissn: rec.eissn,
            posi_id: posiRec.id,
            posi_title: posiRec.title,
            posi_issn_l: posiRec.issn_l,
            posi_issn_print: posiRec.issn_print,
            posi_issn_online: posiRec.issn_online,
          })
        }
      }
      continue
    }

    // No ISSN in common with anything in POSI. Before calling this a
    // coverage gap, check whether the *title* matches a POSI record with a
    // *different* ISSN — that's the "POSI's stored ISSN looks wrong" case.
    const foldedShowjcrTitle = foldTitle(rec.journal)
    const titleHits = posiIndex.byTitle.get(foldedShowjcrTitle) ?? []
    if (titleHits.length > 0) {
      const confidence = isGenericShortTitle(foldedShowjcrTitle) ? 'low_generic_title' : 'normal'
      for (const posiRec of titleHits) {
        issnMismatches.push({
          family,
          type: 'issn_mismatch_on_title_match',
          confidence,
          showjcr_journal: rec.journal,
          showjcr_issn: rec.issn,
          showjcr_eissn: rec.eissn,
          posi_id: posiRec.id,
          posi_title: posiRec.title,
          posi_issn_l: posiRec.issn_l,
          posi_issn_print: posiRec.issn_print,
          posi_issn_online: posiRec.issn_online,
        })
      }
      continue
    }

    notFound.push({ family, showjcr_journal: rec.journal, showjcr_issn: rec.issn, showjcr_eissn: rec.eissn })
  }

  return { titleMismatches, issnMismatches, notFound, matchedCount }
}

/**
 * Cross-checks a title-only ShowJCR family (CCF, CCFT, early-warning —
 * none of these carry an ISSN column in the source, see extract.mjs).
 * Without an independent ISSN there's nothing to detect a *mismatch*
 * against — this can only report "found by exact title match" (informational,
 * with the family's own extra fields attached — CCF tier, warning reason)
 * or "not found" (a coverage candidate, lower-confidence than the
 * ISSN-anchored families' notFound since title matching alone can miss
 * real matches on harmless title variants).
 *
 * @param {object[]} records - each has at least `journal`; extra fields
 *   (chineseName/category/tier/warningReason) are passed through untouched.
 * @param {{ byIssn: Map, byTitle: Map }} posiIndex
 * @returns {{ found: object[], notFound: object[] }}
 */
export function crossCheckTitleOnlyFamily(records, posiIndex, family) {
  const found = []
  const notFound = []
  for (const rec of records) {
    const hits = posiIndex.byTitle.get(foldTitle(rec.journal)) ?? []
    if (hits.length > 0) {
      for (const posiRec of hits) {
        found.push({ family, ...rec, posi_id: posiRec.id, posi_title: posiRec.title })
      }
    } else {
      notFound.push({ family, ...rec })
    }
  }
  return { found, notFound }
}
