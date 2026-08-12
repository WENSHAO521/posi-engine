import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHttpStatus, classifyFetchException, isPathDisallowedByRobots } from '../src/evidence-fetch.mjs'

test('classifyHttpStatus: 2xx is ok, 403/404/429 are their own distinct statuses', () => {
  assert.equal(classifyHttpStatus(200), 'ok')
  assert.equal(classifyHttpStatus(204), 'ok')
  assert.equal(classifyHttpStatus(403), 'forbidden')
  assert.equal(classifyHttpStatus(404), 'not_found')
  assert.equal(classifyHttpStatus(429), 'rate_limited')
})

test('classifyHttpStatus: 5xx and other 4xx are not silently "ok" or conflated with 403/429', () => {
  assert.equal(classifyHttpStatus(500), 'not_found')
  assert.equal(classifyHttpStatus(502), 'not_found')
  assert.equal(classifyHttpStatus(401), 'not_found')
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
