#!/usr/bin/env node
/**
 * check-publisher-registry.mjs — for every entry in posi-data's
 * evidence/publishers/*.json: does its evidence_url still answer
 * (src/website-url.mjs liveness), and what the ETL does with the entry
 * (registryEntryStatus: active, pending the next methodology version,
 * draft, or invalid)? Prints a Markdown table and writes the same as JSON.
 *
 * Usage:
 *   node scripts/check-publisher-registry.mjs --registry <posi-data>/evidence/publishers --out report.json
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fetchWithStatus } from '../src/evidence-fetch.mjs'
import { liveness } from '../src/website-url.mjs'
import { registryEntryStatus } from '../src/evidence-publisher-registry.mjs'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : null
}

async function main() {
  const dir = resolve(arg('registry'))
  const entries = readdirSync(dir).filter(f => f.endsWith('.json')).sort().flatMap(f => {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
    return (Array.isArray(c) ? c : [c]).map(e => ({ file: f, ...e }))
  })
  const checked = new Map()
  const rows = []
  for (const e of entries) {
    if (!e.evidence_url) {
      rows.push({ file: e.file, publisher: e.publisher, policy_type: e.policy_type, evidence_url: null, url_status: null, url_alive: 'no_candidate', etl_status: registryEntryStatus(e) })
      continue
    }
    if (!checked.has(e.evidence_url)) {
      const r = await fetchWithStatus(e.evidence_url, { timeoutMs: 20000, maxBodyBytes: 256 * 1024 })
      checked.set(e.evidence_url, { status: r.http_status ?? r.fetch_status, alive: liveness(r) })
    }
    const c = checked.get(e.evidence_url)
    rows.push({ file: e.file, publisher: e.publisher, policy_type: e.policy_type, evidence_url: e.evidence_url, url_status: c.status, url_alive: c.alive, etl_status: registryEntryStatus(e) })
  }
  const out = resolve(arg('out'))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(rows, null, 2) + '\n', 'utf-8')

  const dead = rows.filter(r => r.url_alive === 'dead')
  console.log(`## Publisher registry: ${rows.length} entries, ${new Set(rows.map(r => r.publisher)).size} publishers\n`)
  const n = s => rows.filter(r => r.etl_status === s).length
  console.log(`Active (inherited now): ${n('active')}. Verified, pending the next methodology version: ${n('pending')}. Drafts (ignored until verified): ${n('draft')}. Invalid (verified but unusable): ${n('invalid')}. Evidence URLs not answering: ${dead.length}. Without a candidate URL yet: ${rows.filter(r => r.url_alive === 'no_candidate').length}.\n`)
  console.log('| Publisher | Policy | URL | Answers | ETL status |\n|---|---|---|---|---|')
  for (const r of rows) console.log(`| ${r.publisher} | ${r.policy_type} | ${r.evidence_url ?? '–'} | ${r.url_alive === 'no_candidate' ? 'no candidate yet' : r.url_alive === 'alive' ? 'yes' : r.url_alive === 'dead' ? `**no** (${r.url_status})` : `? (${r.url_status})`} | ${r.etl_status} |`)
}

main().catch(err => { console.error(err); process.exit(1) })
