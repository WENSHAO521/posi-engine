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
  'timeout',
  'network_error',
  'robots_blocked',
  'parse_error',
])

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
  // Any other non-2xx (3xx exhausted past redirect-follow, other 4xx, 5xx)
  // is still a real, distinct outcome from "not found" -- reported as
  // not_found's sibling `other_error` would over-fragment the enum the
  // framework asked for, so 5xx/other 4xx fold into not_found (the page is
  // not usably available) but keep the real httpStatus alongside it for
  // the fetch-event log, so nothing is actually lost.
  return 'not_found'
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
