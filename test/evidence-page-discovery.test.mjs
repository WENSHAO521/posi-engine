import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverLinks, candidateUrls, CANDIDATE_PATHS } from '../src/evidence-page-discovery.mjs'

test('discoverLinks finds same-origin, keyword-matching links and resolves relative hrefs', () => {
  const html = `
    <a href="/about-us">About</a>
    <a href="/publication-ethics">Ethics</a>
    <a href="https://example.com/journal-policies">Our Policies</a>
    <a href="https://other-site.com/about">A different journal's about page</a>
    <a href="/random-unrelated-page">Random</a>
    <a href="mailto:editor@example.com">Email</a>
  `
  const links = discoverLinks(html, 'https://example.com/')
  assert.ok(links.includes('https://example.com/about-us'))
  assert.ok(links.includes('https://example.com/publication-ethics'))
  assert.ok(links.includes('https://example.com/journal-policies'))
  assert.ok(!links.some(l => l.includes('other-site.com')), 'cross-origin links are excluded')
  assert.ok(!links.some(l => l.includes('random-unrelated-page')), 'links matching no discovery keyword are excluded')
  assert.ok(!links.some(l => l.startsWith('mailto:')), 'mailto: links are excluded')
})

test('discoverLinks deduplicates and strips trailing slashes', () => {
  const html = `<a href="/about">A</a><a href="/about/">B</a>`
  const links = discoverLinks(html, 'https://example.com')
  assert.equal(links.length, 1)
})

test('discoverLinks returns empty array for null/empty html or an unparseable base URL', () => {
  assert.deepEqual(discoverLinks(null, 'https://example.com'), [])
  assert.deepEqual(discoverLinks('<a href="/about">A</a>', 'not-a-url'), [])
})

test('REVIEW-CAUGHT GAP, FIXED: a link whose URL has no policy-shaped substring is still found via its anchor TEXT', () => {
  const html = `<a href="/node/123">Publication Ethics</a>`
  const links = discoverLinks(html, 'https://example.com')
  assert.deepEqual(links, ['https://example.com/node/123'], 'the URL alone ("/node/123") matches no DISCOVERY_KEYWORDS -- only the link text does')
})

test('discoverLinks strips nested tags from anchor text before keyword matching', () => {
  const html = `<a href="/node/456"><span class="icon"></span>Author Guidelines</a>`
  const links = discoverLinks(html, 'https://example.com')
  assert.deepEqual(links, ['https://example.com/node/456'])
})

test('REVIEW-CAUGHT BUG, FIXED: a lookalike domain (same string prefix, different real origin) is excluded, not just filtered by startsWith', () => {
  const html = `<a href="https://example.com.attacker.test/ethics">Publication Ethics</a>`
  const links = discoverLinks(html, 'https://example.com')
  assert.deepEqual(links, [], 'startsWith("https://example.com") would wrongly match this attacker-controlled domain; exact origin equality must not')
})

test('REVIEW-CAUGHT BUG, FIXED: relative hrefs resolve against the PAGE they were found on, not always the journal homepage', () => {
  // A caller passing the page's own URL (not the site's root) as baseUrl
  // must resolve "ethics" relative to that page's directory.
  const html = `<a href="ethics">Publication Ethics</a>`
  const links = discoverLinks(html, 'https://example.com/about')
  assert.deepEqual(links, ['https://example.com/ethics'], 'a relative href on /about resolves relative to /about, i.e. to /ethics, not /about/ethics -- standard URL relative-resolution rules (no trailing slash on /about)')
})

test('candidateUrls builds one absolute URL per CANDIDATE_PATHS entry, with the root path returning the base URL unchanged', () => {
  const urls = candidateUrls('https://journal.example.com/')
  assert.equal(urls.length, CANDIDATE_PATHS.length)
  assert.equal(urls[0], 'https://journal.example.com')
  assert.ok(urls.includes('https://journal.example.com/publication-ethics'))
})

import { selectNewLinks } from '../src/evidence-page-discovery.mjs'

test('selectNewLinks skips links already fetched and keeps discovery order', () => {
  const fetched = new Set(['https://example.com/a'])
  assert.deepEqual(
    selectNewLinks(['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], fetched, 10),
    ['https://example.com/b', 'https://example.com/c'],
  )
})

test('selectNewLinks caps at the budget, and a zero or negative budget selects nothing', () => {
  const links = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']
  assert.equal(selectNewLinks(links, new Set(), 2).length, 2)
  assert.deepEqual(selectNewLinks(links, new Set(), 0), [])
  assert.deepEqual(selectNewLinks(links, new Set(), -3), [])
})

test('selectNewLinks: the budget is not reduced by the fixed candidate paths already tried', () => {
  // Every fixed candidate path is "already fetched" (mostly 404s on a given site);
  // all 30 discovered links must still be selectable.
  const fetched = new Set(candidateUrls('https://example.com'))
  const discovered = Array.from({ length: 30 }, (_, i) => `https://example.com/journal/x/page/policy-${i}`)
  assert.equal(selectNewLinks(discovered, fetched, 30).length, 30)
})

import { discoveryBaseUrl } from '../src/evidence-page-discovery.mjs'

test('discoverLinks: the journal code in every URL does not count as a keyword hit', () => {
  // "aimed" contains the discovery keyword "aim"; without ignoreTokens every link under it matches.
  const html = `
    <a href="/journal/aimed/issue/view/3">Volume 2</a>
    <a href="/journal/aimed/article/view/12">A paper</a>
    <a href="/journal/aimed/page/ai-use-policy">AI Use</a>
    <a href="/journal/aimed/page/human-and-animal-ethics">Ethics</a>
  `
  const base = 'https://www.ai-press.org/journal/aimed/page/policies'
  const without = discoverLinks(html, base)
  assert.equal(without.length, 4, 'documents the problem: every link matches through "aim"')
  const withTokens = discoverLinks(html, base, { ignoreTokens: ['aimed'] })
  assert.deepEqual(withTokens.sort(), [
    'https://www.ai-press.org/journal/aimed/page/ai-use-policy',
    'https://www.ai-press.org/journal/aimed/page/human-and-animal-ethics',
  ])
})

test('discoverLinks: a keyword in the link text still matches when the URL says nothing', () => {
  const html = `<a href="/node/123">Publication Ethics</a><a href="/node/124">Our team</a>`
  assert.deepEqual(discoverLinks(html, 'https://example.com/journal/x/', { ignoreTokens: ['x'] }), ['https://example.com/node/123'])
})

test('discoverLinks finds contact pages', () => {
  assert.deepEqual(discoverLinks('<a href="/page/contact-us">Contact</a>', 'https://example.com/'), ['https://example.com/page/contact-us'])
})

test('discoveryBaseUrl uses the post-redirect URL so relative links resolve under it', () => {
  const page = { url: 'https://example.com/policies', final_url: 'https://example.com/policies/' }
  assert.equal(discoveryBaseUrl(page), 'https://example.com/policies/')
  assert.deepEqual(discoverLinks('<a href="ai-policy">AI</a>', discoveryBaseUrl(page)), ['https://example.com/policies/ai-policy'])
  // without it, the same link resolves to the wrong place
  assert.deepEqual(discoverLinks('<a href="ai-policy">AI</a>', page.url), ['https://example.com/ai-policy'])
})

test('discoveryBaseUrl keeps the requested URL when there is no redirect, or when it leaves the origin', () => {
  assert.equal(discoveryBaseUrl({ url: 'https://example.com/a' }), 'https://example.com/a')
  assert.equal(discoveryBaseUrl({ url: 'https://example.com/a', final_url: 'https://example.com/a' }), 'https://example.com/a')
  assert.equal(discoveryBaseUrl({ url: 'https://example.com/a', final_url: 'https://other.test/a' }), 'https://example.com/a')
  assert.equal(discoveryBaseUrl({ url: 'https://example.com/a', final_url: 'not a url' }), 'https://example.com/a')
})
