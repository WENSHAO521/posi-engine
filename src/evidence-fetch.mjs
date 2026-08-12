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
 * Disallow prefix matching the target path) under a User-agent group that
 * applies to this UA or `*`. Deliberately does not implement the full
 * robots.txt grammar (Allow overrides, wildcards, crawl-delay) -- a
 * conservative under-implementation that only ever blocks on an
 * unambiguous, explicit disallow is safer than a permissive one that might
 * silently ignore a real disallow rule it failed to parse.
 *
 * Groups multiple consecutive `User-agent:` lines correctly -- review-
 * caught bug in an earlier version: it reset "does this apply to us" on
 * every single User-agent line, so a real robots.txt shape like
 *   User-agent: POSI-EvidenceETL
 *   User-agent: Googlebot
 *   Disallow: /private
 * (both UAs sharing one ruleset, standard robots.txt grouping) lost our
 * own UA's applicability the moment the SECOND User-agent line was
 * parsed, before the Disallow line it was meant to apply to was even
 * reached. Per the standard, a run of consecutive User-agent lines forms
 * one group; the group's rules apply to the FIRST group whose agent list
 * contains our own UA token, falling back to a `*` group.
 * @param {string} robotsTxt
 * @param {string} path - e.g. '/about'
 * @param {string} userAgentToken - the UA string's product token, e.g. 'POSI-EvidenceETL'
 * @returns {boolean} true if disallowed
 */
export function isPathDisallowedByRobots(robotsTxt, path, userAgentToken) {
  if (!robotsTxt) return false
  const lines = robotsTxt.split('\n').map(l => l.split('#')[0].trim()).filter(Boolean)
  const uaLower = userAgentToken.toLowerCase()

  const groups = []
  let current = null
  for (const line of lines) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()
    if (key === 'user-agent') {
      // A new group starts only when the previous line wasn't itself a
      // User-agent line (i.e. we're not mid-group) -- consecutive
      // User-agent lines accumulate into the SAME group.
      if (!current || current.sawDirective) {
        current = { agents: [], disallows: [], sawDirective: false }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if (current) {
      current.sawDirective = true
      if (key === 'disallow' && value) current.disallows.push(value)
    }
  }

  const specificGroup = groups.find(g => g.agents.some(a => a !== '*' && uaLower.includes(a)))
  const starGroup = groups.find(g => g.agents.includes('*'))
  const effective = specificGroup ?? starGroup
  if (!effective) return false
  return effective.disallows.some(prefix => path.startsWith(prefix))
}

/** Response bodies larger than this are treated as unusable rather than
 * buffered in full -- guards a 1000-journal batch run against one
 * misbehaving server (or a non-HTML binary served with a text-ish
 * Content-Type) consuming unbounded memory across concurrent fetches.
 * 5MB comfortably exceeds any real policy page's HTML size. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024

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
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES
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

    const declaredLength = Number(res.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return { url, fetch_status: 'parse_error', http_status: res.status, body: null, retrieved_at, error: `response body exceeds ${maxBodyBytes} bytes (Content-Length: ${declaredLength})` }
    }

    try {
      // Read via a streamed byte-counter, not res.text() directly -- a
      // server that lies about (or omits) Content-Length could otherwise
      // still cause an unbounded read; this enforces the cap regardless of
      // what the server claims.
      const body = await readBodyWithCap(res, maxBodyBytes)
      return { url, fetch_status: 'ok', http_status: res.status, body, retrieved_at, error: null }
    } catch (parseErr) {
      return { url, fetch_status: 'parse_error', http_status: res.status, body: null, retrieved_at, error: String(parseErr?.message ?? parseErr) }
    }
  } catch (err) {
    const fetch_status = classifyFetchException(err)
    return { url, fetch_status, http_status: null, body: null, retrieved_at, error: String(err?.message ?? err) }
  }
}

/**
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyWithCap(res, maxBytes) {
  if (!res.body) return res.text()
  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new Error(`response body exceeded ${maxBytes} bytes while streaming`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8')
}
