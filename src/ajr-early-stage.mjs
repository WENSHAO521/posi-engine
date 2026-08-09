/**
 * AJR-E — POSI Automated Journal Rating, Early-Stage model. Implements
 * posi-data/AJR-SPEC.md § 2-3 (formula unchanged from AJR v0.3's 100-point
 * rubric — AJR-E is that rubric, formally scoped to the 12-59 month
 * lifecycle window).
 *
 * Pure functions: every scorer takes already-fetched evidence (crawled
 * site signals, a sampled article list, precomputed booleans) and returns
 * a number. No I/O — fetching the evidence (crawling a journal's website,
 * querying Crossref/OpenAlex) is the caller's responsibility, same
 * separation as pci.mjs and ranking.mjs.
 *
 * Governing principle (posi-data/AJR-SPEC.md § 11, unchanged from v0.3):
 * no reviewer, editor, publisher, sponsor, or POSI administrator has a way
 * to directly set a score, percentile, or quartile — only the underlying
 * evidence passed into these functions can be corrected.
 */

export const AJR_E_METHODOLOGY_VERSION = 'AJR-E-1.0'

export function clamp(v, max) { return Math.max(0, Math.min(v, max)) }

/**
 * @param {{ editorialBoard: boolean, peerReview: boolean, aimScope: boolean }|null} site
 */
export function scoreEditorialGovernance(site) {
  // Editorial Governance & Peer Review /15
  if (!site) return 0
  let s = 0
  if (site.editorialBoard) s += 6
  if (site.peerReview) s += 6
  if (site.aimScope) s += 3
  return clamp(s, 15)
}

/**
 * @param {{ corrections: boolean, plagiarism: boolean, dataAvailability: boolean, ethics: boolean, editorialBoard: boolean }|null} site
 */
export function scoreResearchIntegrity(site) {
  // Research Integrity & Publication Ethics /15
  if (!site) return 0
  let s = 0
  if (site.corrections) s += 3
  if (site.plagiarism) s += 3
  if (site.dataAvailability) s += 3
  if (site.ethics) s += 3
  if (site.editorialBoard) s += 3 // authorship/COI oversight assumed only if a governing board is disclosed
  return clamp(s, 15)
}

export function scoreInfrastructure(sitemapOk, robotsOk, openAlexFound, doiResolves) {
  // Metadata & Digital Publishing Infrastructure /15
  let s = 0
  if (sitemapOk) s += 4
  if (robotsOk) s += 3
  if (openAlexFound) s += 4
  if (doiResolves) s += 4
  return clamp(s, 15)
}

/**
 * @param {{ frequencyStated: boolean }|null} site
 */
export function scorePublishingStability(site, articleCount, monthsSinceLaunch, doiResolves) {
  // Publishing Stability & Operational Performance /15
  let s = 0
  if (site?.frequencyStated) s += 4
  if (monthsSinceLaunch != null && monthsSinceLaunch > 0 && articleCount >= monthsSinceLaunch / 2) s += 7
  if (doiResolves) s += 4
  return clamp(s, 15)
}

/**
 * @param {{ openAccess: boolean, license: boolean, apc: boolean, waiver: boolean }|null} site
 */
export function scoreTransparency(site) {
  // Openness, Data & Transparency /10
  if (!site) return 0
  let s = 0
  if (site.openAccess) s += 4
  if (site.license) s += 4
  if (site.apc || site.waiver) s += 2
  return clamp(s, 10)
}

function normalizeForDup(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/**
 * @param {{ title: string, hasAbstract: boolean, referenceCount: number, hasLicense: boolean, publishedDate: string|null, authors: { affiliation: string|null, orcid: string|null }[] }[]} articles
 *   - a sample of the journal's real Crossref-registered articles
 */
export function scoreOutputSignals(articles) {
  // Scholarly Output Quality Signals /20 — see AJR-SPEC.md / EARLY-STAGE-RATING-SPEC.md §4.1.
  // Computed from real sampled articles, not policy pages: structural
  // completeness, reference integrity, and publication-pattern anomalies.
  // Not a claim of verifying scientific correctness — a check for the
  // structural hallmarks of real, individually-reviewed scholarship.
  if (!articles || articles.length === 0) return 0

  let completenessSum = 0
  for (const a of articles) {
    const fields = [
      a.hasAbstract,
      a.referenceCount > 0,
      a.authors.some(x => x.affiliation),
      a.authors.some(x => x.orcid),
      a.hasLicense,
    ]
    completenessSum += fields.filter(Boolean).length / fields.length
  }
  const completeness = (completenessSum / articles.length) * 10

  const avgRefs = articles.reduce((s, a) => s + a.referenceCount, 0) / articles.length
  const refScore = avgRefs >= 15 ? 5 : avgRefs >= 8 ? 3 : avgRefs >= 1 ? 1 : 0

  let patternScore = 5
  const normTitles = articles.map(a => normalizeForDup(a.title))
  let dupFound = false
  for (let i = 0; i < normTitles.length && !dupFound; i++) {
    for (let j = i + 1; j < normTitles.length; j++) {
      if (normTitles[i] && normTitles[i] === normTitles[j]) { dupFound = true; break }
    }
  }
  if (dupFound) patternScore -= 2

  const authorCounts = new Map()
  for (const a of articles) {
    for (const au of a.authors) {
      const key = au.orcid ?? au.affiliation
      if (!key) continue
      authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1)
    }
  }
  const maxAuthorShare = authorCounts.size > 0 ? Math.max(...authorCounts.values()) / articles.length : 0
  if (maxAuthorShare > 0.6) patternScore -= 2

  const dates = articles.map(a => a.publishedDate).filter(Boolean)
  if (dates.length >= 5 && new Set(dates).size === 1) patternScore -= 2

  return clamp(Math.round(completeness + refScore + clamp(patternScore, 5)), 20)
}

function normalizeAffiliation(s) {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/**
 * @param {{ authors: { affiliation: string|null }[] }[]} articles
 */
export function scoreReachConcentration(articles) {
  // Scholarly Reach & Concentration /10 — see AJR-SPEC.md / EARLY-STAGE-RATING-SPEC.md §4.2.
  // Deliberately NOT a nationality/diversity metric — flags over-reliance on
  // a single institution via a coarse, string-based affiliation match.
  const totalAuthors = articles.reduce((s, a) => s + a.authors.length, 0)
  const affiliations = articles.flatMap(a => a.authors.map(au => au.affiliation).filter(Boolean))
  // Sparse affiliation metadata is a completeness problem (already scored
  // elsewhere), not evidence of concentration — neutral default here.
  if (totalAuthors === 0 || affiliations.length / totalAuthors < 0.3) return 5

  const normalized = affiliations.map(normalizeAffiliation)
  const counts = new Map()
  for (const n of normalized) counts.set(n, (counts.get(n) ?? 0) + 1)
  const maxShare = Math.max(...counts.values()) / normalized.length
  const uniqueRatio = counts.size / normalized.length

  let s = 0
  s += maxShare <= 0.4 ? 6 : maxShare <= 0.6 ? 4 : maxShare <= 0.8 ? 2 : 0
  s += uniqueRatio >= 0.6 ? 4 : uniqueRatio >= 0.3 ? 2 : 0
  return clamp(s, 10)
}

/**
 * Combines all 7 sub-scores into the AJR-E total. Callers are expected to
 * have already gated eligibility (minimum evidence bar, lifecycle stage)
 * before calling this — see posi-data/AJR-SPEC.md § 1/§ 6 for the
 * eligibility and Evidence Coverage gates this does NOT implement itself.
 */
export function computeAjrE({ site, sitemapOk, robotsOk, openAlexFound, doiResolves, articleCount, monthsSinceLaunch, articles }) {
  const egf = scoreEditorialGovernance(site)
  const rif = scoreResearchIntegrity(site)
  const inf = scoreInfrastructure(sitemapOk, robotsOk, openAlexFound, doiResolves)
  const pub = scorePublishingStability(site, articleCount, monthsSinceLaunch, doiResolves)
  const soc = scoreOutputSignals(articles)
  const rdc = scoreReachConcentration(articles)
  const trn = scoreTransparency(site)
  const total = egf + rif + inf + pub + soc + rdc + trn
  return { subfactors: { egf, rif, inf, pub, soc, rdc, trn }, total }
}
