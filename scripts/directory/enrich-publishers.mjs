#!/usr/bin/env node
/**
 * enrich-publishers.mjs
 *
 * Fills missing `publisher` and `country` on Discovered journals from Crossref, which knows the DOI-registering member of every
 * journal it holds.
 *
 * Per ISSN (online first, then print):
 *   1. /journals/{issn}                    → publisher name
 *   2. /works?filter=issn:{issn}&rows=1    → Crossref member id (and publisher, if 1 had none)
 *   3. /members/{id}                       → member postal address → country
 *
 * Caveats, and why only blank fields are filled:
 *   - Crossref's publisher is the member that deposits the DOIs. For some
 *     journals that is a host university, platform or sponsoring agency rather
 *     than the imprint on the journal.
 *   - The member address is where the member is registered, not necessarily the
 *     journal's place of publication, so it ranks below the ISSN Portal and DOAJ.
 *     It fills only `country` (declared country) and never `registration_country`,
 *     which is the ISSN Portal's registration country (see src/lib/schema.ts).
 *     The country is taken only when the address ends in a recognised country name.
 *     Hosting platforms and deposit agents seen doing this are listed in
 *     NOT_PUBLISHERS; a lookup that ends at one of them fills nothing.
 *   - Journals whose DOIs are registered elsewhere (DataCite, JaLC, mEDRA, CNKI)
 *     or that have no DOIs are not found.
 *
 * Each journal looked up gets `crossref_checked_at` (YYYY-MM-DD), whether or not
 * Crossref had it. Journals never checked go first, then the oldest checks;
 * a journal checked within RECHECK_DAYS is skipped. With --budget-minutes the
 * run stops starting new lookups when time is up, so a daily job works
 * through the backlog over several runs. Lookups with a failed request are
 * not stamped, so they are retried next time.
 *
 * Usage:
 *   node scripts/enrich-publishers.mjs                          # dry run over every candidate
 *   node scripts/enrich-publishers.mjs --limit 200              # dry run over a sample
 *   node scripts/enrich-publishers.mjs --write                  # apply
 *   node scripts/enrich-publishers.mjs --write --budget-minutes 15
 *   node scripts/enrich-publishers.mjs --no-country             # publisher only
 */

import { fileURLToPath } from 'url'
import { loadDiscovered, saveDiscovered, DISCOVERED_FILE } from './lib/discovered-store.mjs'
import { countryFromAddress } from './lib/country-codes.mjs'

const CR = 'https://api.crossref.org'
const MAILTO = 'posi@panorama-sg.com'
const UA = `POSI/0.1 (https://posi.panorama-sg.com; mailto:${MAILTO})`
const CONCURRENCY = 3        // Crossref's polite pool allows 3 concurrent requests
const RECHECK_DAYS = 90

/** Requests that failed outright (network, timeouts, 429/5xx after retries), so a blocked run is not read as "not in Crossref". */
export const stats = { failed: 0 }

// Crossref members that register DOIs for other publishers' journals: national
// hosting platforms, "Journals Online" sites and deposit agents. Found on the
// first real run (e.g. CMV Verlag, a German agent, for Iranian university
// journals; Egyptian Knowledge Bank for Egyptian faculties). Their name is not
// the journal's publisher and their address is not its country.
export const NOT_PUBLISHERS = [
  /^egyptian knowledge bank$/i, /^kezana\b/i, /^egypts? presidential specialized council/i,
  /^cmv verlag$/i, /^openedition$/i, /^persee\b/i, /^consortium [ée]rudit$/i,
  /journals online$/i, /^centre for evaluation in education and science$/i,
  /^gn1 sistemas/i, /^central library of the slovak academy of sciences$/i,
  /^det kgl\. bibliotek/i, /^relawan jurnal indonesia$/i,
]
export const isPlatform = name => typeof name === 'string' && NOT_PUBLISHERS.some(re => re.test(name.trim()))

const blank = v => v == null || (typeof v === 'string' && !v.trim())

async function getJson(fetchFn, path, ctx) {
  const sep = path.includes('?') ? '&' : '?'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(`${CR}${path}${sep}mailto=${MAILTO}`, {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000),
      })
      if (res.status === 404) return null
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue }
      if ([401, 403, 407].includes(res.status)) break   // blocked, not an answer about the journal
      if (!res.ok) return null
      return (await res.json())?.message ?? null
    } catch {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  stats.failed++
  if (ctx) ctx.failed++
  return null
}

/** Crossref lookup for one journal. Returns { publisher, country, member, failed } with nulls for what was not found; failed counts requests that got no answer. */
export async function lookup(issns, { fetchFn = fetch, memberCache = new Map(), wantCountry = true } = {}) {
  const ctx = { failed: 0 }
  let publisher = null, member = null
  for (const issn of issns) {
    const j = await getJson(fetchFn, `/journals/${encodeURIComponent(issn)}`, ctx)
    if (j?.publisher?.trim()) publisher = j.publisher.trim()
    if (publisher && !wantCountry) break
    const w = await getJson(fetchFn, `/works?filter=issn:${encodeURIComponent(issn)}&rows=1&select=member,publisher`, ctx)
    const item = w?.items?.[0]
    if (item) {
      if (!publisher && item.publisher?.trim()) publisher = item.publisher.trim()
      member = item.member ?? null
    }
    if (publisher && (member || !wantCountry)) break
  }

  let country = null
  if (wantCountry && member) {
    // Cache only answered member records; a failed fetch is retried by the next journal of that member.
    let m = memberCache.get(member)
    if (m === undefined) {
      m = await getJson(fetchFn, `/members/${member}`, ctx)
      if (m) memberCache.set(member, m)
    }
    country = countryFromAddress(m?.location)
    if (!publisher && m?.['primary-name']?.trim()) publisher = m['primary-name'].trim()
    if (isPlatform(m?.['primary-name'])) country = null
  }
  if (isPlatform(publisher)) { publisher = null; country = null }
  return { publisher, country, member, failed: ctx.failed }
}

/** Fill blanks on a record from a lookup result. Returns the list of fields set. */
export function applyResult(r, { publisher, country }) {
  const set = []
  if (blank(r.publisher) && publisher) { r.publisher = publisher; set.push('publisher') }
  if (country && blank(r.country)) { r.country = country; set.push('country') }
  return set
}

async function main() {
  const argv = process.argv.slice(2)
  const WRITE = argv.includes('--write')
  const wantCountry = !argv.includes('--no-country')
  const li = argv.indexOf('--limit')
  const LIMIT = li >= 0 ? Number(argv[li + 1]) : Infinity
  const bi = argv.indexOf('--budget-minutes')
  const DEADLINE = bi >= 0 ? Date.now() + Number(argv[bi + 1]) * 60_000 : Infinity

  const today = new Date().toISOString().slice(0, 10)
  const recheckBefore = new Date(Date.now() - RECHECK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const records = loadDiscovered()
  const needsCountry = r => wantCountry && blank(r.country)
  const needs = records.filter(r => (r.issn_online || r.issn_print) && (blank(r.publisher) || needsCountry(r)))
  const due = needs
    .filter(r => !r.crossref_checked_at || r.crossref_checked_at < recheckBefore)
    .sort((a, b) => (a.crossref_checked_at ?? '').localeCompare(b.crossref_checked_at ?? ''))
  const candidates = due.slice(0, LIMIT)

  console.log(`Missing publisher: ${records.filter(r => blank(r.publisher)).length}`)
  console.log(`Missing country:   ${records.filter(r => blank(r.country)).length}`)
  console.log(`Due for a Crossref check: ${due.length} (${needs.length - due.length} checked in the last ${RECHECK_DAYS} days)${candidates.length < due.length ? `, taking ${candidates.length}` : ''}`)

  const memberCache = new Map()
  const tally = { publisher: 0, country: 0, notFound: 0 }
  let next = 0, done = 0, answered = 0, stop = ''

  async function worker() {
    while (next < candidates.length && !stop) {
      if (Date.now() > DEADLINE) { stop = 'time budget reached'; break }
      const r = candidates[next++]
      const issns = [r.issn_online, r.issn_print].filter(Boolean)
      // Only ask for the member address when this record lacks a country; publisher-only lookups stop after /journals.
      const res = await lookup(issns, { memberCache, wantCountry: needsCountry(r) })
      if (res.failed) {
        // Nothing answering at all (blocked network, outage): stop rather than burn the budget.
        if (answered === 0 && done >= 20) stop = 'Crossref is not answering'
      } else {
        answered++
        r.crossref_checked_at = today
      }
      if (!res.publisher && !res.country && !res.failed) tally.notFound++
      const set = applyResult(r, res)
      for (const f of set) tally[f]++
      if (set.length && !WRITE) console.log(`  ${issns[0]}  ${set.map(f => `${f}=${r[f]}`).join('  ')}`)
      done++
      if (done % 200 === 0) console.error(`  … ${done} / ${candidates.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (stop) console.log(`\nStopped after ${done} of ${candidates.length} journals: ${stop}. The rest follow in later runs.`)

  console.log(`\nPublisher filled:            ${tally.publisher}`)
  console.log(`Country filled:              ${tally.country}`)
  console.log(`Not found in Crossref:       ${tally.notFound} / ${candidates.length}`)
  if (stats.failed) console.log(`Failed requests:             ${stats.failed} (blocked, network or rate limit; those journals were not really checked)`)

  if (WRITE) {
    saveDiscovered(records)
    console.log(`\nWritten to ${DISCOVERED_FILE}. Re-run calc-discovered-mqs.mjs and auto-pqf.mjs --write to refresh scores.`)
  } else {
    console.log('\nDry run — pass --write to apply.')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1) })
}
