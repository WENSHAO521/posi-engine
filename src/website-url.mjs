/**
 * Deciding whether a journal's recorded website_url still leads anywhere,
 * and what replaces it when it does not (scripts/refresh-website-urls.mjs).
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
 * @param {{
 *   current: string|null, currentCheck: object|null,
 *   candidate: string|null, candidateCheck: object|null,
 * }} input - candidate is OpenAlex's homepage_url for the journal
 * @returns {{ action: 'keep'|'add'|'replace'|'dead_no_replacement'|'missing_no_replacement', url: string|null, reason: string }}
 */
export function decideWebsiteUrl({ current, currentCheck, candidate, candidateCheck }) {
  const candidateUsable = candidate && liveness(candidateCheck) === 'alive'
  if (!current) {
    return candidateUsable
      ? { action: 'add', url: candidate, reason: 'no website on record; OpenAlex homepage answers' }
      : { action: 'missing_no_replacement', url: null, reason: candidate ? 'no website on record; OpenAlex homepage does not answer' : 'no website on record or in OpenAlex' }
  }
  const state = liveness(currentCheck)
  if (state !== 'dead') return { action: 'keep', url: current, reason: `recorded website ${state === 'alive' ? 'answers' : 'could not be judged'} (${currentCheck?.fetch_status ?? 'unchecked'})` }
  const why = `recorded website is dead (${currentCheck.http_status ?? currentCheck.fetch_status})`
  if (candidateUsable && !sameAddress(candidate, current)) return { action: 'replace', url: candidate, reason: `${why}; OpenAlex homepage answers` }
  return { action: 'dead_no_replacement', url: current, reason: `${why}; ${!candidate ? 'no OpenAlex homepage' : sameAddress(candidate, current) ? 'OpenAlex has the same address' : 'OpenAlex homepage does not answer either'}` }
}
