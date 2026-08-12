/**
 * Evidence fetch layer — implements the "POSI Journal Evaluation & Ranking
 * Framework 1.0" Evidence ETL v1 fetch stage. Replaces the old website-repo
 * scripts' `fetchText(url) -> string|null` pattern (scripts/rate-early-
 * stage.mjs, scripts/auto-pqf.mjs), which collapsed every failure mode —
 * a 403, a 404, a timeout, a DNS failure — into the same undifferentiated
 * `null`. The framework is explicit that a blocked crawl must never be
 * indistinguishable from a page that genuinely doesn't exist.
 *
 * classifyFetchOutcomeStatus()/describeFetchFailureReason() in
 * evidence-coverage.mjs already do the outcome -> unknown/blocked mapping
 * for scoring purposes; this module is what produces that `outcome` value
 * in the first place, plus the richer 8-value fetch_status taxonomy the
 * framework asks for at the raw-fetch-event level (robots_blocked and
 * parse_error are finer-grained than evidence-coverage.mjs needs for
 * scoring, but matter for the fetch-event log itself).
 */

export const FETCH_STATUSES = Object.freeze([
  'ok',
  'not_found',
  'forbidden',
  'rate_limited',
  'server_error',
  'http_error',
  'timeout',
  'network_error',
  'robots_blocked',
  'parse_error',
])

/** fetch_status values that mean "we asked and got a definitive, resolved
 * answer that this specific URL doesn't exist" -- NOT a fetch problem, and
 * must never be treated as blocking resolver confidence the way
 * server_error/http_error/timeout/network_error/robots_blocked do. A 404
 * on one guessed candidate path says nothing about whether the *criterion*
 * is met/not_met -- that's still decided by whatever else got checked. */
export const CLEAN_ABSENCE_STATUSES = Object.freeze(['not_found'])

/** fetch_status values that mean "something blocked us specifically" --
 * evidence-resolver.mjs maps these toward `blocked`, never `not_met`. */
export const BLOCKING_STATUSES = Object.freeze(['forbidden', 'rate_limited', 'robots_blocked'])

/** fetch_status values that mean "we don't know" for a reason unrelated to
 * deliberate blocking (server-side failure, our own timeout, a network
 * problem, a response we couldn't parse) -- evidence-resolver.mjs maps
 * these toward `unknown`, never `not_met`. */
export const UNKNOWN_STATUSES = Object.freeze(['server_error', 'http_error', 'timeout', 'network_error', 'parse_error'])

/**
 * @param {number} httpStatus
 * @returns {string} one of FETCH_STATUSES (never 'timeout'/'network_error'/
 *   'robots_blocked' -- those are decided before or instead of an HTTP
 *   status existing at all; see fetchWithStatus()).
 */
export function classifyHttpStatus(httpStatus) {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok'
  if (httpStatus === 403) return 'forbidden'
  if (httpStatus === 404) return 'not_found'
  if (httpStatus === 429) return 'rate_limited'
  // 5xx and other non-{200s,403,404,429} 4xx (401, 451, exhausted 3xx, ...)
  // must NOT collapse into `not_found` -- a 404 is a resolved "this URL
  // genuinely doesn't exist" answer; a 500 or a 401 is "something went
  // wrong and we don't actually know what's at this URL," which
  // evidence-coverage.mjs's own classifyFetchOutcomeStatus() already
  // treats as `unknown`, never as a clean absence. Collapsing them
  // together here would let a transient server error on a policy page get
  // read downstream exactly like "we successfully confirmed this page
  // doesn't exist," which is a different, much stronger claim.
  if (httpStatus >= 500) return 'server_error'
  return 'http_error'
}

/**
 * @param {Error} err
 * @returns {'timeout'|'network_error'}
 */
export function classifyFetchException(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout'
  return 'network_error'
}

/**
 * Minimal robots.txt parser -- only checks a flat `Disallow: /` (or a
 * Disallow prefix matching the target path) under a User-agent block that
 * applies to this UA or `*`. Deliberately does not implement the full
 * robots.txt grammar (Allow overrides, wildcards, crawl-delay) -- a
 * conservative under-implementation that only ever blocks on an
 * unambiguous, explicit disallow is safer than a permissive one that might
 * silently ignore a real disallow rule it failed to parse.
 * @param {string} robotsTxt
 * @param {string} path - e.g. '/about'
 * @param {string} userAgentToken - the UA string's product token, e.g. 'POSI-EvidenceETL'
 * @returns {boolean} true if disallowed
 */
export function isPathDisallowedByRobots(robotsTxt, path, userAgentToken) {
  if (!robotsTxt) return false
  const lines = robotsTxt.split('\n').map(l => l.trim())
  let currentAppliesToUs = false
  let sawSpecificBlock = false
  const disallowsForUs = []
  const disallowsForStar = []
  let inStarBlock = false

  for (const raw of lines) {
    const line = raw.split('#')[0].trim()
    if (!line) continue
    const [rawKey, ...rest] = line.split(':')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') {
      const ua = value.toLowerCase()
      inStarBlock = ua === '*'
      currentAppliesToUs = ua === '*' || userAgentToken.toLowerCase().includes(ua)
      if (userAgentToken.toLowerCase().includes(ua) && ua !== '*') sawSpecificBlock = true
      continue
    }
    if (key === 'disallow' && value) {
      if (currentAppliesToUs && !inStarBlock) disallowsForUs.push(value)
      if (inStarBlock) disallowsForStar.push(value)
    }
  }

  const effective = sawSpecificBlock ? disallowsForUs : disallowsForStar
  return effective.some(prefix => path.startsWith(prefix))
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.userAgent]
 * @returns {Promise<{
 *   url: string, fetch_status: string, http_status: number|null,
 *   body: string|null, retrieved_at: string, error: string|null
 * }>}
 */
export async function fetchWithStatus(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  const userAgent = opts.userAgent ?? 'POSI-EvidenceETL/1.0 (+https://posi.panorama-sg.com; posi@panorama-sg.com)'
  const retrieved_at = new Date().toISOString()

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const fetch_status = classifyHttpStatus(res.status)
    if (fetch_status !== 'ok') {
      return { url, fetch_status, http_status: res.status, body: null, retrieved_at, error: null }
    }
    try {
      const body = await res.text()
      return { url, fetch_status: 'ok', http_status: res.status, body, retrieved_at, error: null }
    } catch (parseErr) {
      return { url, fetch_status: 'parse_error', http_status: res.status, body: null, retrieved_at, error: String(parseErr?.message ?? parseErr) }
    }
  } catch (err) {
    const fetch_status = classifyFetchException(err)
    return { url, fetch_status, http_status: null, body: null, retrieved_at, error: String(err?.message ?? err) }
  }
}
