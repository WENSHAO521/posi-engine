import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHttpStatus, classifyFetchException, isPathDisallowedByRobots, BLOCKING_STATUSES, UNKNOWN_STATUSES, CLEAN_ABSENCE_STATUSES, MAX_BODY_BYTES } from '../src/evidence-fetch.mjs'

test('classifyHttpStatus: 2xx is ok, 403/404/429 are their own distinct statuses', () => {
  assert.equal(classifyHttpStatus(200), 'ok')
  assert.equal(classifyHttpStatus(204), 'ok')
  assert.equal(classifyHttpStatus(403), 'forbidden')
  assert.equal(classifyHttpStatus(404), 'not_found')
  assert.equal(classifyHttpStatus(429), 'rate_limited')
})

test('classifyHttpStatus: 5xx is server_error, other unclassified 4xx is http_error -- neither collapses into not_found (review-caught bug)', () => {
  // A 404 is a resolved "this URL genuinely doesn't exist" answer. A 500
  // or a 401 is "something went wrong, we don't know what's really at this
  // URL" -- collapsing them together would let a transient server error on
  // a policy page read downstream exactly like a confirmed clean absence.
  assert.equal(classifyHttpStatus(500), 'server_error')
  assert.equal(classifyHttpStatus(502), 'server_error')
  assert.equal(classifyHttpStatus(503), 'server_error')
  assert.equal(classifyHttpStatus(401), 'http_error')
  assert.equal(classifyHttpStatus(451), 'http_error')
})

test('server_error and http_error are both in UNKNOWN_STATUSES, never in CLEAN_ABSENCE_STATUSES or BLOCKING_STATUSES', () => {
  assert.ok(UNKNOWN_STATUSES.includes('server_error'))
  assert.ok(UNKNOWN_STATUSES.includes('http_error'))
  assert.ok(!CLEAN_ABSENCE_STATUSES.includes('server_error'))
  assert.ok(!CLEAN_ABSENCE_STATUSES.includes('http_error'))
  assert.ok(!BLOCKING_STATUSES.includes('server_error'))
  assert.ok(!BLOCKING_STATUSES.includes('http_error'))
})

test('CLEAN_ABSENCE_STATUSES contains only not_found -- a 404 is the only outcome that means "resolved, does not exist"', () => {
  assert.deepEqual([...CLEAN_ABSENCE_STATUSES], ['not_found'])
})

test('BLOCKING_STATUSES is exactly forbidden/rate_limited/robots_blocked', () => {
  assert.deepEqual([...BLOCKING_STATUSES].sort(), ['forbidden', 'rate_limited', 'robots_blocked'].sort())
})

test('classifyFetchException: AbortSignal.timeout() rejections are timeout, everything else is network_error', () => {
  assert.equal(classifyFetchException({ name: 'TimeoutError' }), 'timeout')
  assert.equal(classifyFetchException({ name: 'AbortError' }), 'timeout')
  assert.equal(classifyFetchException({ name: 'TypeError', message: 'fetch failed' }), 'network_error')
  assert.equal(classifyFetchException(new Error('ENOTFOUND')), 'network_error')
})

test('isPathDisallowedByRobots: a flat "Disallow: /" under User-agent: * blocks everything', () => {
  const robots = 'User-agent: *\nDisallow: /'
  assert.equal(isPathDisallowedByRobots(robots, '/about', 'POSI-EvidenceETL'), true)
  assert.equal(isPathDisallowedByRobots(robots, '/', 'POSI-EvidenceETL'), true)
})

test('isPathDisallowedByRobots: a specific-path disallow only blocks that prefix', () => {
  const robots = 'User-agent: *\nDisallow: /admin\nDisallow: /private'
  assert.equal(isPathDisallowedByRobots(robots, '/about', 'POSI-EvidenceETL'), false)
  assert.equal(isPathDisallowedByRobots(robots, '/admin/users', 'POSI-EvidenceETL'), true)
})

test('isPathDisallowedByRobots: no matching Disallow line means allowed', () => {
  const robots = 'User-agent: *\nAllow: /'
  assert.equal(isPathDisallowedByRobots(robots, '/about', 'POSI-EvidenceETL'), false)
})

test('isPathDisallowedByRobots: empty/missing robots.txt never blocks (fetchWithStatus already treats a 404 on robots.txt as "no rules")', () => {
  assert.equal(isPathDisallowedByRobots('', '/about', 'POSI-EvidenceETL'), false)
  assert.equal(isPathDisallowedByRobots(null, '/about', 'POSI-EvidenceETL'), false)
})

test('isPathDisallowedByRobots: a UA-specific block overrides the wildcard block for that UA', () => {
  const robots = 'User-agent: POSI-EvidenceETL\nDisallow:\n\nUser-agent: *\nDisallow: /'
  // Our specific UA has an explicit empty Disallow (= allowed everything),
  // which must take priority over the blanket "*" disallow.
  assert.equal(isPathDisallowedByRobots(robots, '/about', 'POSI-EvidenceETL/1.0'), false)
})

test('REVIEW-CAUGHT BUG, FIXED: two consecutive User-agent lines sharing one Disallow ruleset both apply, not just the first', () => {
  const robots = 'User-agent: POSI-EvidenceETL\nUser-agent: Googlebot\nDisallow: /private'
  // Prior version reset "does this apply to us" on the SECOND User-agent
  // line before the shared Disallow was reached, losing our own UA's
  // applicability to a rule that, per standard robots.txt grouping
  // semantics, plainly does apply to it.
  assert.equal(isPathDisallowedByRobots(robots, '/private/x', 'POSI-EvidenceETL/1.0'), true)
  assert.equal(isPathDisallowedByRobots(robots, '/about', 'POSI-EvidenceETL/1.0'), false)
})

test('isPathDisallowedByRobots: a group\'s Disallow only applies to that group, not a later unrelated group', () => {
  const robots = 'User-agent: Googlebot\nDisallow: /google-only\n\nUser-agent: *\nDisallow: /everyone'
  assert.equal(isPathDisallowedByRobots(robots, '/google-only', 'POSI-EvidenceETL/1.0'), false, 'this group is for Googlebot specifically, not us, and we fall through to the * group')
  assert.equal(isPathDisallowedByRobots(robots, '/everyone', 'POSI-EvidenceETL/1.0'), true)
})

test('MAX_BODY_BYTES is a sane positive number, exported for fetchWithStatus callers to reference', () => {
  assert.equal(typeof MAX_BODY_BYTES, 'number')
  assert.ok(MAX_BODY_BYTES > 0)
})
