/**
 * Evidence page discovery — Evidence ETL v1's second stage. A homepage-only
 * crawl systematically misses policy content large traditional-publisher
 * platforms put on dedicated subpages (see scripts/rate-early-stage.mjs's
 * own header comment in the website repo, which found exactly this against
 * a real benchmark run). This module combines a fixed candidate-path list
 * with same-origin link discovery from whatever pages *were* fetched, so
 * discovery isn't limited to paths this list happened to anticipate.
 */

/** Known policy-page path conventions, including OJS's own default "About
 * the Journal" submenu structure (verified against two different Core
 * Collection OJS installations using two different slugs for the same
 * page -- editorialTeam vs editorialMasthead -- confirming both are
 * needed, not just one). */
export const CANDIDATE_PATHS = Object.freeze([
  '/',
  '/about',
  '/about/aims-and-scope',
  '/about/editorialTeam',
  '/about/editorialMasthead',
  '/about/submissions',
  '/aims-and-scope',
  '/editorial-board',
  '/editorial-policies',
  '/peer-review',
  '/publication-ethics',
  '/ethics',
  '/author-guidelines',
  '/for-authors',
  '/submissions',
  '/apc',
  '/fees',
  '/copyright',
  '/licensing',
  '/corrections',
  '/retractions',
  '/archiving',
  '/data-policy',
  '/ai-policy',
])

/** Keywords in an href or link text that mark it as worth fetching even
 * when it doesn't match a CANDIDATE_PATHS entry exactly -- catches
 * publisher-specific slugs (e.g. a journal using /journal-policies instead
 * of /editorial-policies) that a fixed path list can't anticipate. */
const DISCOVERY_KEYWORDS = [
  'about', 'aim', 'scope', 'editor', 'board', 'peer-review', 'peer_review',
  'ethic', 'polic', 'author-guide', 'guideline', 'submission', 'submit',
  'apc', 'fee', 'charge', 'copyright', 'licens', 'retract', 'correction',
  'errata', 'archiv', 'preserv', 'data-availab', 'data-shar', 'ai-polic',
  'artificial-intelligence',
]

/**
 * Extracts same-origin candidate links from an HTML page via a plain
 * regex `<a href="...">` scan -- no DOM/HTML parser dependency added
 * (matching this repo's existing minimal-dependency convention). This is
 * intentionally permissive rather than a full HTML parse: false positives
 * (a link that matches a keyword but isn't actually a policy page) just
 * cost one extra fetch and get filtered out downstream by having no
 * matching evidence signal; false negatives (missing a real policy link)
 * are the worse failure mode this exists to avoid.
 * @param {string} html
 * @param {string} baseUrl - the page's own URL, for same-origin filtering
 *   and resolving relative hrefs.
 * @returns {string[]} deduplicated, same-origin, keyword-matching URLs
 */
export function discoverLinks(html, baseUrl) {
  if (!html) return []
  let origin
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return []
  }

  const hrefPattern = /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["']/gi
  const found = new Set()
  let match
  while ((match = hrefPattern.exec(html)) !== null) {
    const raw = match[1].trim()
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue

    let resolved
    try {
      resolved = new URL(raw, baseUrl).toString()
    } catch {
      continue
    }
    if (!resolved.startsWith(origin)) continue

    const lower = resolved.toLowerCase()
    if (DISCOVERY_KEYWORDS.some(kw => lower.includes(kw))) {
      found.add(resolved.replace(/\/$/, ''))
    }
  }
  return [...found]
}

/**
 * @param {string} baseWebsiteUrl
 * @returns {string[]} absolute URLs for every CANDIDATE_PATHS entry against
 *   this journal's base website URL.
 */
export function candidateUrls(baseWebsiteUrl) {
  const base = baseWebsiteUrl.replace(/\/+$/, '')
  return CANDIDATE_PATHS.map(p => (p === '/' ? base : `${base}${p}`))
}
