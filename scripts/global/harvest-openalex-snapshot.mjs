#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.1 — harvest every OpenAlex journal from the public
 * OpenAlex snapshot on S3 (s3://openalex/data/jsonl/sources/, served over
 * HTTPS). This is OpenAlex's recommended route for bulk access: no API key,
 * no daily budget, the whole sources table (about 330 MB compressed) in a
 * few minutes. Output lines match harvest-openalex-journals.mjs.
 *
 *   node scripts/global/harvest-openalex-snapshot.mjs --out <dir>/openalex-journals.jsonl  *     [--profiles <dir>/openalex-profiles.jsonl] [--keep-raw <dir>]
 *
 * --profiles writes one compact profile per journal for the journal pages:
 * titles, homepage, APC, citation history, h-index and top topics.
 * --keep-raw also writes each journal's raw OpenAlex record (topics included)
 * to <dir>/openalex-sources-raw.jsonl, for classification audits.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { createGunzip } from 'zlib'
import { Readable } from 'stream'
import { createInterface } from 'readline'
import { arg } from './lib.mjs'
import { fromOpenAlexSource } from '../../src/global-index.mjs'

const BASE = 'https://openalex.s3.amazonaws.com'

/** Compact journal profile. Short keys: 158k of these are served as static shards. */
export function profileOf(s) {
  const st = s.summary_stats ?? {}
  const years = (s.counts_by_year ?? []).map(c => [c.year, c.works_count ?? 0, c.cited_by_count ?? 0]).sort((a, b) => a[0] - b[0])
  const topics = (s.topics ?? []).slice(0, 6).map(t => [t.display_name, t.subfield?.display_name ?? null, t.field?.display_name ?? null, t.count ?? 0])
  const p = {
    id: String(s.id).replace('https://openalex.org/', ''),
    t: s.display_name,
    ab: s.abbreviated_title || undefined,
    alt: (s.alternate_titles ?? []).filter(x => x && x !== s.display_name).slice(0, 4),
    hp: s.homepage_url || undefined,
    apc: s.apc_usd ?? undefined,
    cc: s.country_code || undefined,
    pub: s.host_organization_name || undefined,
    w: s.works_count ?? 0,
    c: s.cited_by_count ?? 0,
    h: st.h_index ?? undefined,
    i10: st.i10_index ?? undefined,
    y0: s.first_publication_year ?? undefined,
    y1: s.last_publication_year ?? undefined,
    cy: years,
    tp: topics,
    soc: (s.societies ?? []).map(x => x.organization).filter(Boolean).slice(0, 3),
  }
  if (!p.alt.length) delete p.alt
  if (!p.soc.length) delete p.soc
  return p
}
const out = arg('out')
const keepRaw = arg('keep-raw')
const profilesOut = arg('profiles')
if (!out) { console.error('Usage: --out <file.jsonl> [--keep-raw <dir>]'); process.exit(1) }
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })

const manifest = await (await fetch(`${BASE}/data/jsonl/sources/manifest.json`)).json()
const parts = (manifest.files ?? manifest.entries).map(e => e.url.replace(/^s3:\/\/openalex/, BASE))
console.log(`OpenAlex snapshot ${manifest.date ?? ''}: ${parts.length} parts, ${manifest.record_count ?? manifest.meta?.record_count ?? '?'} sources`)

const w = createWriteStream(out)
const prof = profilesOut ? createWriteStream(profilesOut) : null
const raw = keepRaw ? createWriteStream(join(keepRaw, 'openalex-sources-raw.jsonl')) : null
let sources = 0, journals = 0

for (const [i, url] of parts.entries()) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const lines = createInterface({ input: Readable.fromWeb(res.body).pipe(createGunzip()), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line) continue
        sources++
        const s = JSON.parse(line)
        if (s.type !== 'journal') continue
        journals++
        w.write(JSON.stringify(fromOpenAlexSource(s)) + '\n')
        if (prof) prof.write(JSON.stringify(profileOf(s)) + '\n')
        if (raw) raw.write(JSON.stringify({ id: s.id, display_name: s.display_name, issn_l: s.issn_l, issn: s.issn, works_count: s.works_count, topics: s.topics }) + '\n')
      }
      break
    } catch (e) {
      if (attempt >= 4) throw e
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  process.stdout.write(`\rparts ${i + 1}/${parts.length}  sources ${sources}  journals ${journals}   `)
}
await new Promise(r => w.end(r))
if (raw) await new Promise(r => raw.end(r))
if (prof) await new Promise(r => prof.end(r))
console.log(`\nWrote ${journals} journals to ${out}`)
