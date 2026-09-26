#!/usr/bin/env node
/**
 * GLOBAL-INDEX-1.0 § 3.3 — merge the harvested files into one corpus that
 * run-pcs-etl.mjs consumes directly.
 *
 *   node scripts/global/build-global-corpus.mjs \
 *     --openalex <dir>/openalex-journals.jsonl --crossref <dir>/crossref-journals.jsonl \
 *     --curated <posi-data>/corpus/core-collection.json --curated <posi-data>/corpus/global-benchmark.json \
 *     --out <dir>/global-corpus.json
 *
 * Writes the corpus plus <out>.summary.json (counts by source, PSC confidence).
 */
import { readFileSync, writeFileSync } from 'fs'
import { arg } from './lib.mjs'
import { readJsonl } from './lib.mjs'
import { buildGlobalCorpus, normIssn } from '../../src/global-index.mjs'

const all = name => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) o.push(process.argv[i + 1]); return o }
const out = arg('out')
if (!out) { console.error('Usage: --openalex <jsonl> --crossref <jsonl> [--curated <json> ...] --out <json>'); process.exit(1) }

const openalex = all('openalex').flatMap(readJsonl)
const crossref = all('crossref').flatMap(readJsonl)
const curated = all('curated').flatMap(p => JSON.parse(readFileSync(p, 'utf-8')))
  .filter(j => j.posi_id)
  .map(j => ({ posi_id: j.posi_id, issns: [j.issn_online, j.issn_print].map(normIssn).filter(Boolean) }))

const corpus = buildGlobalCorpus(openalex, crossref, curated)
writeFileSync(out, JSON.stringify(corpus))

const tally = key => corpus.reduce((a, r) => { const k = Array.isArray(r[key]) ? r[key].join('+') : String(r[key]); a[k] = (a[k] ?? 0) + 1; return a }, {})
const summary = {
  journals: corpus.length,
  curated: corpus.filter(r => r.curated).length,
  by_source: tally('sources'),
  by_psc_confidence: tally('psc_confidence'),
  inputs: { openalex: openalex.length, crossref: crossref.length, curated: curated.length },
}
writeFileSync(`${out}.summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
