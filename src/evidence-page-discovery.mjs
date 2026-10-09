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
  'artificial-intelligence', 'contact',
]

/**
 * Extracts same-origin candidate links from an HTML page via a plain
 * regex `<a href="...">...</a>` scan -- no DOM/HTML parser dependency
 * added (matching this repo's existing minimal-dependency convention).
 * This is intentionally permissive rather than a full HTML parse: false
 * positives (a link that matches a keyword but isn't actually a policy
 * page) just cost one extra fetch and get filtered out downstream by
 * having no matching evidence signal; false negatives (missing a real
 * policy link) are the worse failure mode this exists to avoid.
 * @param {string} html
 * @param {string} baseUrl - the URL of the page THIS html came from (not
 *   necessarily the journal's homepage) -- both for resolving relative
 *   hrefs correctly (an `href="ethics"` found on `/about` must resolve to
 *   `/about/ethics`, not to a root-relative `/ethics`) and for same-origin
 *   filtering.
 * @param {object} [opts]
 * @param {string[]} [opts.ignoreTokens] - text that is part of every URL on
 *   this journal's site and says nothing about the target page, typically the
 *   journal code. A keyword hit in the URL path that lies wholly inside an occurrence of a token is ignored (a hit that runs past it, the host and the link text still count): for the journal code
 *   "aimed", every link under /journal/aimed/ contains the keyword "aim", so
 *   without this every navigation, issue and article link would match.
 * @returns {string[]} deduplicated, same-origin, keyword-matching URLs
 */
export function discoverLinks(html, baseUrl, { ignoreTokens = [] } = {}) {
  if (!html) return []
  let origin
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return []
  }

  // Captures the href attribute AND the anchor's inner text -- review-
  // caught gap: a link like <a href="/node/123">Publication Ethics</a>
  // has a URL with no policy-shaped substring at all, but the link TEXT
  // plainly says what it is. Checking hrefs alone missed exactly this
  // shape, which is common on non-OJS/custom CMS journal sites.
  const anchorPattern = /<a\s+[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>(.*?)<\/a>/gis
  const found = new Set()
  let match
  while ((match = anchorPattern.exec(html)) !== null) {
    const raw = match[1].trim()
    const linkText = match[2].replace(/<[^>]+>/g, ' ').trim()
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue

    let resolved
    try {
      resolved = new URL(raw, baseUrl)
    } catch {
      continue
    }
    // Exact origin equality, not startsWith() -- review-caught bug:
    // "https://example.com.attacker.test/ethics".startsWith(
    // "https://example.com") is true, so a naive prefix check would treat
    // an entirely different, attacker-controlled domain as same-origin.
    if (resolved.origin !== origin) continue

    // A keyword hit inside the URL path is ignored when it lies wholly within
    // an occurrence of an ignore token (the journal code): "aim" inside "aimed"
    // says nothing about the target page. A hit that runs past the token still
    // counts ("data-shar" for a journal coded "data"), as do hits in the host
    // and in the link text, which says what the link is even when the journal
    // code happens to be a keyword.
    const pathPart = `${resolved.pathname}${resolved.search}`.toLowerCase()
    const hostPart = resolved.origin.toLowerCase()
    const textPart = linkText.toLowerCase()
    const tokenSpans = ignoreSpans(pathPart, ignoreTokens)
    const hit = DISCOVERY_KEYWORDS.some(kw =>
      hostPart.includes(kw) || textPart.includes(kw) || hasKeywordOutsideSpans(pathPart, kw, tokenSpans))
    if (hit) {
      found.add(resolved.toString().replace(/\/$/, ''))
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

/**
 * Picks the links to fetch next: those not fetched yet, at most `budget`.
 * The budget is for discovered links only. Fixed candidate paths are tried
 * first and mostly answer 404, so counting them against a shared page limit
 * left a journal with ~27 guessed paths room for 3 discovered links, and its
 * Policies pages were cut off.
 * @param {Iterable<string>} links
 * @param {Set<string>} alreadyFetched
 * @param {number} budget
 * @returns {string[]}
 */
export function selectNewLinks(links, alreadyFetched, budget) {
  return [...links].filter(u => !alreadyFetched.has(u)).slice(0, Math.max(0, budget))
}

/**
 * The URL relative links in a fetched page resolve against: the URL after
 * redirects (so `/policies` redirecting to `/policies/` resolves `href="x"`
 * as `/policies/x`), unless the redirect left the origin of the requested
 * URL, in which case the requested URL is kept so discovery stays on the
 * journal's own site.
 * @param {{ url: string, final_url?: string }} page
 * @returns {string}
 */
export function discoveryBaseUrl(page) {
  if (!page.final_url || page.final_url === page.url) return page.url
  try {
    return new URL(page.final_url).origin === new URL(page.url).origin ? page.final_url : page.url
  } catch {
    return page.url
  }
}

/** [start, end) of every occurrence of every token in `text` (lower-case). */
function ignoreSpans(text, tokens) {
  const spans = []
  for (const raw of tokens) {
    const token = raw ? String(raw).toLowerCase() : ''
    if (!token) continue
    for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + 1)) spans.push([i, i + token.length])
  }
  return spans
}

/** Whether `keyword` occurs in `text` at a place not wholly inside an ignored span. */
function hasKeywordOutsideSpans(text, keyword, spans) {
  for (let i = text.indexOf(keyword); i !== -1; i = text.indexOf(keyword, i + 1)) {
    const end = i + keyword.length
    if (!spans.some(([s, e]) => i >= s && end <= e)) return true
  }
  return false
}
