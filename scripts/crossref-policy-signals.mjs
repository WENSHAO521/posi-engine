#!/usr/bin/env node
/**
 * crossref-policy-signals.mjs — TRIAL, read only. For each journal of a
 * sample: the share of its Crossref articles of the last three years carrying policy-related
 * deposits (src/crossref-policy-signals.mjs), and what the site evidence
 * coverage would become if those signals resolved the items the crawl could
 * not (unknown / blocked). Prints Markdown (job summary) and writes JSON.
 * Nothing is written to any corpus or score.
 *
 * Usage:
 *   node scripts/crossref-policy-signals.mjs --sample sample.json \
 *     --evidence-journals <site crawl journals dir> --out signals.json [--rows 100]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fetchCrossrefWorksPage } from '../src/works-fetch.mjs'
import { journalSignalShares, journalItemShares, applyCrossrefSignals, CROSSREF_POLICY_SELECT_FIELDS, CANDIDATE_MAPPING, MIN_SHARE, MIN_ARTICLES } from '../src/crossref-policy-signals.mjs'
import { evidenceCoverage, EC_OFFICIAL_THRESHOLD, EC_PROVISIONAL_THRESHOLD } from '../src/evidence-coverage.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
const load = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null)
const band = c => (c >= EC_OFFICIAL_THRESHOLD ? 'official' : c >= EC_PROVISIONAL_THRESHOLD ? 'provisional' : 'below')
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, '') } catch { return '(none)' } }

async function main() {
  const sample = load(resolve(arg('sample')))
  const evDir = resolve(arg('evidence-journals'))
  const rows = Number(arg('rows', '100'))
  // Exactly the last three years up to today: no forthcoming records.
  const now = new Date()
  const until = now.toISOString().slice(0, 10)
  const since = new Date(Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10)
  const out = []
  for (const j of sample) {
    const issns = [j.issn_online, j.issn_print].filter(Boolean)
    let works = []
    const attempts = []
    for (const issn of issns) {
      const page = await fetchCrossrefWorksPage(issn, { rows, offset: 0, sort: 'published', order: 'desc', filter: `type:journal-article,from-pub-date:${since},until-pub-date:${until}`, selectFields: CROSSREF_POLICY_SELECT_FIELDS })
      attempts.push({ issn, status: page.status, error: page.error })
      if (page.items.length) { works = page.items; break }
      // Try the other ISSN only after a definitive empty answer; an outage
      // is reported as such, never as "no articles".
      if (page.status !== 200 && page.status !== 404) break
    }
    const failed = !works.length && attempts.some(a => a.status !== 200 && a.status !== 404)
    const status = failed ? attempts.find(a => a.status !== 200 && a.status !== 404).status : attempts.at(-1)?.status ?? null
    const shares = journalSignalShares(works)
    const itemShares = journalItemShares(works)
    const ev = load(join(evDir, `${j.posi_id}.json`))
    const items = ev?.evidence_items ?? []
    const before = items.length ? evidenceCoverage(items).coverage_percent : null
    const { items: after, upgraded } = applyCrossrefSignals(items, itemShares)
    const afterPct = items.length ? evidenceCoverage(after).coverage_percent : null
    out.push({ posi_id: j.posi_id, title: j.title, publisher: j.publisher ?? null, host: hostOf(j.website_url), crossref_status: status, crossref_failed: failed, crossref_attempts: attempts, shares, item_shares: itemShares, site_coverage_before: before, site_coverage_after: afterPct, upgraded })
    console.error(`${j.posi_id} ${j.title}: ${works.length} articles; coverage ${before} -> ${afterPct} (+${upgraded.join(', ') || 'nothing'})`)
  }

  const o = resolve(arg('out'))
  mkdirSync(dirname(o), { recursive: true })
  writeFileSync(o, JSON.stringify(out, null, 2) + '\n', 'utf-8')

  const withEv = out.filter(r => r.site_coverage_before != null)
  const count = (rs, f) => rs.filter(f).length
  const mean = xs => (xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null)
  const signals = ['license', 'crossmark', 'review_dates', 'open_review', 'coi', 'data', 'funder']
  const md = v => String(v ?? '–').replace(/\|/g, '\\|')
  const lines = [
    `## Crossref policy signals (trial, read only): ${out.length} journals`, '',
    `Candidate mapping (item ← signal, when ≥ ${MIN_SHARE * 100}% of ≥ ${MIN_ARTICLES} recent articles carry at least one of its signals; only unknown/blocked items are upgraded): ${Object.entries(CANDIDATE_MAPPING).map(([k, v]) => `${k} ← ${v.join(' or ')}`).join('; ')}.`, '',
    `Recent Crossref articles (${since} to ${until}): any for ${count(out, r => r.shares.articles > 0)} of ${out.length} journals; at least ${MIN_ARTICLES} (enough to upgrade an item) for ${count(out, r => r.shares.articles >= MIN_ARTICLES)}; Crossref failed for ${count(out, r => r.crossref_failed)}.`, '',
    '| Site coverage band | Before | After |', '|---|---|---|',
    ...['official', 'provisional', 'below'].map(b => `| ${b} | ${count(withEv, r => band(r.site_coverage_before) === b)} | ${count(withEv, r => band(r.site_coverage_after) === b)} |`),
    `| mean coverage | ${mean(withEv.map(r => r.site_coverage_before))}% | ${mean(withEv.map(r => r.site_coverage_after))}% |`, '',
    '| Item | Journals upgraded |', '|---|---|',
    ...Object.keys(CANDIDATE_MAPPING).map(k => `| ${k} | ${count(out, r => r.upgraded.includes(k))} |`), '',
    `| Signal | Journals with ≥ ${MIN_SHARE * 100}% of articles |`, '|---|---|',
    ...signals.map(s => `| ${s} | ${count(out, r => r.shares.articles >= MIN_ARTICLES && r.shares[s] >= MIN_SHARE)} |`), '',
    '| Journal | Publisher | Host | Articles | ' + signals.join(' | ') + ' | Coverage before → after |',
    '|---|---|---|---|' + signals.map(() => '---|').join('') + '---|',
    ...out.map(r => `| ${r.posi_id} ${md(r.title)} | ${md(r.publisher)} | ${r.host} | ${r.shares.articles} | ${signals.map(s => Math.round((r.shares[s] ?? 0) * 100)).join(' | ')} | ${r.site_coverage_before ?? '–'} → ${r.site_coverage_after ?? '–'} |`),
  ]
  console.log(lines.join('\n'))
}

main().catch(err => { console.error(err); process.exit(1) })
