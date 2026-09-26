#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.1 — harvest every OpenAlex journal from the public
 * OpenAlex snapshot on S3 (s3://openalex/data/jsonl/sources/, served over
 * HTTPS). This is OpenAlex's recommended route for bulk access: no API key,
 * no daily budget, the whole sources table (about 330 MB compressed) in a
 * few minutes. Output lines match harvest-openalex-journals.mjs.
 *
 *   node scripts/global/harvest-openalex-snapshot.mjs --out <dir>/openalex-journals.jsonl [--keep-raw <dir>]
 *
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
const out = arg('out')
const keepRaw = arg('keep-raw')
if (!out) { console.error('Usage: --out <file.jsonl> [--keep-raw <dir>]'); process.exit(1) }
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })

const manifest = await (await fetch(`${BASE}/data/jsonl/sources/manifest.json`)).json()
const parts = (manifest.files ?? manifest.entries).map(e => e.url.replace(/^s3:\/\/openalex/, BASE))
console.log(`OpenAlex snapshot ${manifest.date ?? ''}: ${parts.length} parts, ${manifest.record_count ?? manifest.meta?.record_count ?? '?'} sources`)

const w = createWriteStream(out)
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
console.log(`\nWrote ${journals} journals to ${out}`)
