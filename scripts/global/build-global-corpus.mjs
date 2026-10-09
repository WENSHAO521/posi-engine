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
 * Writes the corpus plus <out>.summary.json (counts by source, PSC confidence,
 * and title_mismatches: curated journals whose Crossref/OpenAlex title
 * differs from the curated title and is not yet one of its alternate titles).
 *
 * --openalex-issn-map <json> (from harvest-openalex-snapshot.mjs --issn-map)
 * links journals known only to Crossref to an OpenAlex source that is not
 * typed as a journal, by ISSN.
 */
import { readFileSync, writeFileSync } from 'fs'
import { arg } from './lib.mjs'
import { readJsonl } from './lib.mjs'
import { buildGlobalCorpus, normIssn, titleMismatches } from '../../src/global-index.mjs'

const all = name => { const o = []; for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === `--${name}`) o.push(process.argv[i + 1]); return o }
const out = arg('out')
if (!out) { console.error('Usage: --openalex <jsonl> --crossref <jsonl> [--curated <json> ...] --out <json>'); process.exit(1) }

const openalex = all('openalex').flatMap(readJsonl)
const crossref = all('crossref').flatMap(readJsonl)
const curated = all('curated').flatMap(p => JSON.parse(readFileSync(p, 'utf-8')))
  .filter(j => j.posi_id)
  .map(j => ({
    posi_id: j.posi_id, issns: [j.issn_online, j.issn_print].map(normIssn).filter(Boolean),
    title: j.title ?? null, alternate_titles: j.alternate_titles ?? null, collection_status: j.collection_status ?? null,
  }))

const corpus = buildGlobalCorpus(openalex, crossref, curated)

const issnMapFile = arg('openalex-issn-map')
let linked = 0
if (issnMapFile) {
  const issnMap = JSON.parse(readFileSync(issnMapFile, 'utf-8'))
  for (const r of corpus) {
    if (r.openalex_source_id) continue
    const hit = [r.issn_l, ...(r.issns ?? [])].filter(Boolean).map(x => issnMap[String(x).toUpperCase()]).find(Boolean)
    if (hit) { r.openalex_source_id = hit[0]; r.openalex_source_type = hit[1]; linked++ }
  }
}
writeFileSync(out, JSON.stringify(corpus))

const tally = key => corpus.reduce((a, r) => { const k = Array.isArray(r[key]) ? r[key].join('+') : String(r[key]); a[k] = (a[k] ?? 0) + 1; return a }, {})
const summary = {
  journals: corpus.length,
  curated: corpus.filter(r => r.curated).length,
  by_source: tally('sources'),
  by_psc_confidence: tally('psc_confidence'),
  inputs: { openalex: openalex.length, crossref: crossref.length, curated: curated.length },
  linked_to_non_journal_openalex_source: linked,
  title_mismatches: titleMismatches(corpus, curated),
}
writeFileSync(`${out}.summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ...summary, title_mismatches: summary.title_mismatches.length }, null, 2))
