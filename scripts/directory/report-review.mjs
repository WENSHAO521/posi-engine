#!/usr/bin/env node
// After a directory sync: if the run proposed a different title or ISSN for a journal (proposed-changes.csv),
// or held a new journal for review (posi-data audits/migrations/directory-sync-<today>/review.json), open (or add
// to) one issue on this repository listing them, so a person sees them instead of finding them in a run artifact.
// The same list is not posted twice: each post carries a digest, and a post whose digest is already on the issue
// is skipped.
//
//   node scripts/directory/report-review.mjs --report-dir work/apply-report --data posi-data \
//     --title 'Directory sync: changes to review' [--dry-run]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : d }
const reportDir = arg('report-dir', 'work/apply-report')
const data = arg('data', 'posi-data')
const title = arg('title', 'Directory sync: changes to review')
const dryRun = process.argv.includes('--dry-run')
const today = arg('date', new Date().toISOString().slice(0, 10))
const MAX_ROWS = 80

export function buildReport({ proposedCsv, review }) {
  const rows = (proposedCsv ?? '').trim().split('\n').slice(1).filter(Boolean)
  const held = review?.title_overlaps ?? []
  const conflicts = review?.conflicts ?? []
  const quarantined = review?.quarantined ?? []
  if (!rows.length && !held.length && !conflicts.length && !quarantined.length) return null
  const out = []
  if (rows.length) {
    out.push(`### Different title or ISSN found (${rows.length}), not applied`, '', '| journal_code | field | now | found |', '|---|---|---|---|')
    for (const r of rows.slice(0, MAX_ROWS)) {
      const [code, field, ...rest] = r.split(',')
      const [before, after] = splitQuoted(rest.join(','))
      out.push(`| ${code} | ${field} | ${cell(before)} | ${cell(after)} |`)
    }
    if (rows.length > MAX_ROWS) out.push('', `…and ${rows.length - MAX_ROWS} more in the run's directory-sync-report artifact (proposed-changes.csv).`)
    out.push('')
  }
  if (held.length) {
    out.push(`### New journals held for review (${held.length})`, '')
    for (const h of held) {
      const c = (h.candidates ?? []).map(x => `${(x.issns ?? []).join(' / ')}${x.publisher ? ` (${x.publisher})` : ''}`).join('; ')
      out.push(`- **${h.title}**: ${c}${h.existing_ids?.length ? `; same title as ${h.existing_ids.join(', ')}` : ''}`)
    }
    out.push('')
  }
  if (conflicts.length) {
    out.push(`### ISSNs belonging to different existing ids (${conflicts.length})`, '')
    for (const c of conflicts) out.push(`- **${c.title}**: ${c.issns.join(' / ')} -> ${c.posi_ids.join(', ')}`)
    out.push('')
  }
  if (quarantined.length) {
    out.push(`### Quarantined, no valid ISSN (${quarantined.length})`, '')
    for (const q of quarantined) out.push(`- **${q.title}**: ${(q.issns ?? []).join(' / ')}`)
    out.push('')
  }
  return out.join('\n')
}

// proposed-changes.csv writes before/after with JSON.stringify.
function splitQuoted(s) {
  const m = s.match(/^("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")$/)
  if (!m) return [s, '']
  return [JSON.parse(m[1]), JSON.parse(m[2])]
}
const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ') || '—'

function main() {
  const csvFile = join(reportDir, 'proposed-changes.csv')
  const reviewFile = join(data, 'audits/migrations', `directory-sync-${today}`, 'review.json')
  const report = buildReport({
    proposedCsv: existsSync(csvFile) ? readFileSync(csvFile, 'utf8') : '',
    review: existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')) : null,
  })
  if (!report) { console.log('Nothing to review.'); return }
  const digest = createHash('sha256').update(report).digest('hex').slice(0, 16)
  const run = process.env.GITHUB_RUN_ID ? `\n\nRun: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''
  const body = `${report}${run}\n\n<!-- review-digest:${digest} -->`
  if (dryRun) { console.log(body); return }
  const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' }).trim()
  const num = gh('issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'number', '-q', '.[0].number')
  if (!num) { gh('issue', 'create', '--title', title, '--body', body); return }
  const seen = gh('issue', 'view', num, '--json', 'body,comments', '-q', '[.body] + [.comments[].body] | join("\n")')
  if (seen.includes(`review-digest:${digest}`)) { console.log(`Same list already on #${num}.`); return }
  gh('issue', 'comment', num, '--body', body)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
