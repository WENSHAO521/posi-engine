#!/usr/bin/env node
/**
 * Quality gate run before a PCS-Q edition is released. Fails (exit 1) when
 * the edition looks damaged rather than merely different, so a bad month at
 * Crossref cannot reach posi-data and the website:
 *
 *   - no journal ranked at all;
 *   - more than 1% of the journals with an ISSN gave up after repeated
 *     transient Crossref failures (network, rate limit, server errors);
 *   - compared with the previous released edition (--previous, optional):
 *     journals in the edition or journals ranked dropped by more than 5%.
 *
 *   node scripts/global/check-edition.mjs --work work [--previous prev/pcs-q-summary.json] [--report report.md]
 *
 * Writes a short Markdown report (for the alert issue) either way.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { arg } from './lib.mjs'

const work = arg('work', 'work')
const previousPath = arg('previous')
const reportPath = arg('report', 'edition-check.md')
const MAX_GAVE_UP = 0.01
const MAX_DROP = 0.05

const summary = JSON.parse(readFileSync(join(work, 'pcs-q', 'summary.json'), 'utf-8'))
const jdir = join(work, 'pcs', 'journals')
let withIssn = 0
let gaveUp = 0
for (const f of readdirSync(jdir)) {
  const r = JSON.parse(readFileSync(join(jdir, f), 'utf-8'))
  if (!r.issn_queried) continue
  withIssn++
  if (/gave up after \d+ attempts/.test(r.note ?? '')) gaveUp++
}
const previous = previousPath && existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf-8')) : null

const pct = x => `${(x * 100).toFixed(2)}%`
const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })
check('Journals ranked', summary.overall_ranked > 0, `${summary.overall_ranked} of ${summary.journals_in}`)
check('Transient Crossref failures', gaveUp / Math.max(1, withIssn) <= MAX_GAVE_UP, `${gaveUp} of ${withIssn} journals with an ISSN (${pct(gaveUp / Math.max(1, withIssn))}; limit ${pct(MAX_GAVE_UP)})`)
if (previous) {
  for (const k of ['journals_in', 'overall_ranked']) {
    const drop = (previous[k] - summary[k]) / Math.max(1, previous[k])
    check(`Change in ${k}`, drop <= MAX_DROP, `${previous[k]} -> ${summary[k]} (${drop > 0 ? '-' : '+'}${pct(Math.abs(drop))}; limit -${pct(MAX_DROP)})`)
  }
} else {
  check('Previous edition', true, 'none found; compared against absolute limits only')
}

const failed = checks.filter(c => !c.ok)
const report = [
  `### PCS-Q edition check: ${failed.length ? 'FAILED' : 'passed'}`,
  '',
  '| Check | Result | Detail |',
  '|---|---|---|',
  ...checks.map(c => `| ${c.name} | ${c.ok ? 'pass' : '**fail**'} | ${c.detail} |`),
].join('\n')
writeFileSync(reportPath, report + '\n')
console.log(report)
if (failed.length) process.exit(1)
