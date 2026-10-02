/**
 * Deciding whether a journal's recorded website_url still leads anywhere,
 * and what replaces it when it does not (scripts/refresh-website-urls.mjs):
 * OpenAlex's homepage_url, Wikidata's official website (P856) by ISSN, or a
 * publisher's current address built from the ISSN.
 * Pure functions; the fetching happens in the script.
 *
 * A site that answers at all is alive, even one that refuses the crawler
 * (403/429/robots): refusal is a crawl problem, not a dead address, and a
 * redirect to a new domain is followed by the crawler anyway. A recorded
 * address is dead only when nothing answers there (DNS failure, refused
 * connection, repeated timeout) or the server says the page is gone
 * (404/410).
 */

const ALIVE = new Set(['ok', 'forbidden', 'rate_limited', 'robots_blocked', 'server_error', 'parse_error'])
const DEAD = new Set(['not_found', 'network_error', 'timeout'])

/**
 * @param {{ fetch_status: string, http_status: number|null } | null} check
 * @returns {'alive'|'dead'|'unknown'}
 */
export function liveness(check) {
  if (!check) return 'unknown'
  if (check.http_status === 410) return 'dead'
  if (ALIVE.has(check.fetch_status)) return 'alive'
  if (DEAD.has(check.fetch_status)) return 'dead'
  return 'unknown'
}

// The same resource: only a trailing slash and the host's case are
// ignored; scheme, path and query all count (an https address can be alive
// where its http twin is dead, and ?id= selects the journal).
function sameAddress(a, b) {
  const norm = u => { try { const x = new URL(u); x.pathname = x.pathname.replace(/\/+$/, ''); return x.href } catch { return String(u) } }
  return norm(a) === norm(b)
}

/**
 * Wiley's journal home on its current platform, built from the ISSN
 * (onlinelibrary.wiley.com/journal/<ISSN without hyphen>), for the journals
 * still recorded under retired Blackwell or wiley.com/bw addresses.
 *
 * @param {{ publisher?: string|null, issn_online?: string|null, issn_print?: string|null }} journal
 * @returns {string[]}
 */
export function publisherRewrites(journal) {
  const issns = [journal.issn_online, journal.issn_print].filter(i => /^\d{4}-\d{3}[\dX]$/i.test(i ?? ''))
  if (/wiley|blackwell/i.test(journal.publisher ?? '')) return issns.map(i => `https://onlinelibrary.wiley.com/journal/${i.replace('-', '').toUpperCase()}`)
  return []
}

/**
 * A candidate is usable when it answers. One built by rule rather than
 * recorded somewhere (strict: true) must answer 200: a refusal tells nothing
 * about whether the guessed page exists.
 */
function usable(c) {
  if (!c?.url) return false
  return c.strict ? c.check?.fetch_status === 'ok' : liveness(c.check) === 'alive'
}

/**
 * @param {{
 *   current: string|null, currentCheck: object|null,
 *   candidates?: { url: string|null, check: object|null, source: string, strict?: boolean }[],
 * }} input - candidates in order of preference: OpenAlex's homepage_url,
 *   then Wikidata's official website, then publisher rewrites
 * @returns {{ action: 'keep'|'add'|'replace'|'dead_no_replacement'|'missing_no_replacement', url: string|null, source: string|null, reason: string }}
 */
export function decideWebsiteUrl({ current, currentCheck, candidates = [] }) {
  const tried = candidates.filter(c => c?.url)
  const none = tried.length ? `no candidate answers (${tried.map(c => `${c.source} ${c.check?.http_status ?? c.check?.fetch_status ?? 'unchecked'}`).join(', ')})` : 'no candidate found'
  if (!current) {
    const c = tried.find(usable)
    return c
      ? { action: 'add', url: c.url, source: c.source, reason: `no website on record; ${c.source} answers` }
      : { action: 'missing_no_replacement', url: null, source: null, reason: `no website on record; ${none}` }
  }
  const state = liveness(currentCheck)
  if (state !== 'dead') return { action: 'keep', url: current, source: null, reason: `recorded website ${state === 'alive' ? 'answers' : 'could not be judged'} (${currentCheck?.fetch_status ?? 'unchecked'})` }
  const why = `recorded website is dead (${currentCheck.http_status ?? currentCheck.fetch_status})`
  const others = tried.filter(c => !sameAddress(c.url, current))
  const c = others.find(usable)
  if (c) return { action: 'replace', url: c.url, source: c.source, reason: `${why}; ${c.source} answers` }
  return { action: 'dead_no_replacement', url: current, source: null, reason: `${why}; ${others.length ? none.replace('no candidate', 'no other candidate') : tried.length ? 'every candidate is the same address' : 'no candidate found'}` }
}

/**
 * Wikidata SPARQL results (?issn ?site) to ISSN → official websites, in
 * the order Wikidata returned them, ISSNs upper-cased.
 *
 * @param {{ results?: { bindings?: { issn?: { value: string }, site?: { value: string } }[] } }} json
 * @returns {Map<string, string[]>}
 */
export function parseWikidataSites(json) {
  const out = new Map()
  for (const b of json?.results?.bindings ?? []) {
    const issn = b.issn?.value?.toUpperCase(), site = b.site?.value
    if (!issn || !/^https?:\/\//.test(site ?? '')) continue
    if (!out.has(issn)) out.set(issn, [])
    if (!out.get(issn).includes(site)) out.get(issn).push(site)
  }
  return out
}
