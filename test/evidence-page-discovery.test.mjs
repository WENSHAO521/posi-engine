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
