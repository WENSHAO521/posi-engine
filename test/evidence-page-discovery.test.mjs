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

test('candidateUrls builds one absolute URL per CANDIDATE_PATHS entry, with the root path returning the base URL unchanged', () => {
  const urls = candidateUrls('https://journal.example.com/')
  assert.equal(urls.length, CANDIDATE_PATHS.length)
  assert.equal(urls[0], 'https://journal.example.com')
  assert.ok(urls.includes('https://journal.example.com/publication-ethics'))
})
