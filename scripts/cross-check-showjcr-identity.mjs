#!/usr/bin/env node
/**
 * cross-check-showjcr-identity.mjs
 *
 * QA/diagnostic tool: cross-checks POSI's own OpenAlex-derived journal
 * identity records (journals/**\/*.jsonl in posi-data) against the plain
 * bibliographic identity fields — journal name, ISSN, EISSN — bundled in
 * hitfyd/ShowJCR (github.com/hitfyd/ShowJCR), a GPL-3.0 Chinese academic
 * tool that aggregates several journal/conference reference lists. This
 * catches errors in POSI's own data (a garbled title, a typo'd ISSN) by
 * comparing against an independent source. It does NOT import ShowJCR
 * data into POSI, auto-correct anything, or store anything beyond what's
 * documented below — it only writes a report for a human to act on.
 *
 * WHAT IS AND ISN'T USED FROM SHOWJCR, AND WHY
 * ---------------------------------------------
 * ShowJCR bundles several distinct CSV families. Two of them wrap
 * proprietary third-party analysis products:
 *   - JCR* / FQBJCR* (Journal Citation Reports impact factors & quartiles,
 *     and the CAS Journal Partition Table 中科院分区表 tiers) are
 *     Clarivate's and CAS's own paid, licensed analysis. POSI must never
 *     import, store, redistribute, or display those *values* — the IF
 *     number, the JCR quartile letter, the CAS partition tier — no matter
 *     what GPL-3.0 covers for ShowJCR's own code. Republishing someone
 *     else's paid analysis product isn't relicensed by wrapping it in a
 *     GPL repo.
 *   - This script pulls ONLY `Journal`/`ISSN`/`EISSN` from those families
 *     (see src/showjcr/extract.mjs for the exact column allow-list per
 *     family, plus a copy of this same reasoning right where a future
 *     contributor would be tempted to widen it). Journal name and ISSN
 *     are plain bibliographic facts, not the proprietary analysis itself.
 * Two other families are fuller in scope, deliberately:
 *   - CCF's recommended journal/conference directory (CCF*, CCFT*) is
 *     CCF's own IP, published openly on ccf.org.cn with no paywall, and
 *     citing it is standard practice in Chinese CS academia — its
 *     recommendation category/tier is kept, not just identity.
 *   - The international early-warning list (GJQKYJMD*) is a public
 *     advisory list; its warning-reason field is the entire point of
 *     referencing it, so that's kept too.
 * Nothing from any family is ever written to disk beyond what
 * src/showjcr/extract.mjs's extractors return — the full parsed CSV rows
 * (which do contain IF/quartile/rank/partition-tier columns while sitting
 * in memory mid-parse) are never logged, cached, or serialized anywhere;
 * they're discarded the moment extract.mjs reduces them to identity (+
 * CCF tier / warning reason) fields. No ShowJCR CSV is committed into this
 * repo or into posi-data — everything is fetched fresh at request time
 * from raw.githubusercontent.com.
 *
 * WHAT THIS PRODUCES
 * -------------------
 *   - identity-discrepancy-report.md  — human-readable summary
 *   - identity-discrepancies.csv      — full list of title/ISSN mismatches
 *   - coverage-candidates.csv         — ShowJCR journals not yet in POSI
 *   - showjcr-context-overlay.csv     — POSI journals matched by title in
 *     the title-only families, with CCF tier / early-warning reason
 *     attached for context (informational, not a POSI-computed ranking)
 *
 * Usage:
 *   node scripts/cross-check-showjcr-identity.mjs [--out <dir>]
 *     [--showjcr-repo hitfyd/ShowJCR] [--showjcr-ref master]
 *     [--posi-data-repo WENSHAO521/posi-data] [--posi-data-ref master]
 *
 * Designed to be re-run periodically: both source repos are read live (via
 * `gh api` for directory listings, so it benefits from the caller's `gh`
 * auth/rate limit; plain HTTPS fetch for raw file content), and each
 * family's *latest available year* is auto-detected from the repo's
 * current file listing rather than hardcoded, so new ShowJCR releases are
 * picked up automatically without editing this script.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { parseCsv } from '../src/showjcr/csv.mjs'
import { FAMILIES, pickLatestFile } from '../src/showjcr/extract.mjs'
import { buildPosiIndex, crossCheckIssnFamily, crossCheckTitleOnlyFamily } from '../src/showjcr/match.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

const SHOWJCR_DATA_PATH = '中科院分区表及JCR原始数据文件'

function ghApiJson(path) {
  const out = execFileSync('gh', ['api', path], { maxBuffer: 1024 * 1024 * 64 }).toString()
  return JSON.parse(out)
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`)
  return res.text()
}

/** Lists a ShowJCR data-directory's files via `gh api` (contents endpoint),
 * returning [{ name, download_url }]. */
function listShowjcrFiles(repo, ref) {
  const entries = ghApiJson(`repos/${repo}/contents/${encodeURIComponent(SHOWJCR_DATA_PATH)}?ref=${ref}`)
  return entries.filter(e => e.type === 'file').map(e => ({ name: e.name, download_url: e.download_url }))
}

/** Lists every .jsonl path under journals/ in posi-data via the git trees
 * API (recursive) — picks up new subdirectories/files without hardcoding
 * `journals/core` vs `journals/discovered`. */
function listPosiJournalFiles(repo, ref) {
  const tree = ghApiJson(`repos/${repo}/git/trees/${ref}?recursive=1`)
  return tree.tree
    .filter(e => e.type === 'blob' && e.path.startsWith('journals/') && e.path.endsWith('.jsonl'))
    .map(e => e.path)
}

async function loadPosiRecords(repo, ref) {
  const paths = listPosiJournalFiles(repo, ref)
  if (paths.length === 0) {
    throw new Error(`No journals/**/*.jsonl files found in ${repo}@${ref}`)
  }
  const records = []
  for (const path of paths) {
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`
    const text = await fetchText(rawUrl)
    const lines = text.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const rec = JSON.parse(line)
      records.push({
        id: rec.id,
        title: rec.title,
        issn_l: rec.identifiers?.issn_l ?? null,
        issn_print: rec.identifiers?.issn_print ?? null,
        issn_online: rec.identifiers?.issn_online ?? null,
        source_path: path,
      })
    }
  }
  return records
}

async function loadFamilyRecords(family, files) {
  const picked = pickLatestFile(files.map(f => f.name), family.pattern)
  if (!picked) {
    console.warn(`  [${family.name}] no file in ShowJCR matched pattern ${family.pattern} — skipping`)
    return null
  }
  const entry = files.find(f => f.name === picked.filename)
  const text = await fetchText(entry.download_url)
  const { header, rows } = parseCsv(text)
  const extracted = family.extract(rows, header) // rows/header discarded after this line
  console.log(`  [${family.name}] ${picked.filename}: ${extracted.length} identity records extracted (of ${rows.length} raw rows)`)
  return { filename: picked.filename, year: picked.year, records: extracted }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows, columns) {
  const header = columns.join(',') + '\n'
  const body = rows.map(r => columns.map(c => csvEscape(r[c])).join(',')).join('\n')
  return header + (rows.length > 0 ? body + '\n' : '')
}

async function main() {
  const outDir = resolve(arg('out', 'showjcr-crosscheck-output'))
  const showjcrRepo = arg('showjcr-repo', 'hitfyd/ShowJCR')
  const showjcrRef = arg('showjcr-ref', 'master')
  const posiDataRepo = arg('posi-data-repo', 'WENSHAO521/posi-data')
  const posiDataRef = arg('posi-data-ref', 'master')

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  console.log(`Listing ${showjcrRepo}@${showjcrRef} data files...`)
  const showjcrFiles = listShowjcrFiles(showjcrRepo, showjcrRef)
  console.log(`  found ${showjcrFiles.length} files`)

  console.log(`\nLoading POSI journal records from ${posiDataRepo}@${posiDataRef}...`)
  const posiRecords = await loadPosiRecords(posiDataRepo, posiDataRef)
  console.log(`  loaded ${posiRecords.length} POSI journal records`)
  const posiIndex = buildPosiIndex(posiRecords)

  console.log(`\nFetching latest-year file per ShowJCR family and extracting identity fields...`)
  const familyResults = []
  for (const family of FAMILIES) {
    const result = await loadFamilyRecords(family, showjcrFiles)
    if (result) familyResults.push({ family, ...result })
  }

  const allTitleMismatches = []
  const allIssnMismatches = []
  const allCoverageCandidates = []
  const allContextOverlay = []
  const familySummaries = []

  for (const { family, filename, year, records } of familyResults) {
    if (family.hasIssn) {
      const { titleMismatches, issnMismatches, notFound, matchedCount } = crossCheckIssnFamily(records, posiIndex, family.name)
      allTitleMismatches.push(...titleMismatches)
      allIssnMismatches.push(...issnMismatches)
      allCoverageCandidates.push(...notFound.map(r => ({ ...r, chineseName: '', category: '', tier: '', warningReason: '' })))
      familySummaries.push({
        family: family.label, source: filename, total: records.length,
        matched: matchedCount, titleMismatches: titleMismatches.length,
        issnMismatches: issnMismatches.length, notFound: notFound.length,
      })
    } else {
      const { found, notFound } = crossCheckTitleOnlyFamily(records, posiIndex, family.name)
      allContextOverlay.push(...found)
      allCoverageCandidates.push(...notFound.map(r => ({
        family: r.family, showjcr_journal: r.journal, showjcr_issn: '', showjcr_eissn: '',
        chineseName: r.chineseName ?? '', category: r.category ?? '', tier: r.tier ?? '', warningReason: r.warningReason ?? '',
      })))
      familySummaries.push({
        family: family.label, source: filename, total: records.length,
        matched: found.length, titleMismatches: null, issnMismatches: null, notFound: notFound.length,
      })
    }
  }

  writeFileSync(
    join(outDir, 'identity-discrepancies.csv'),
    toCsv([...allTitleMismatches, ...allIssnMismatches],
      ['family', 'type', 'confidence', 'showjcr_journal', 'showjcr_issn', 'showjcr_eissn', 'posi_id', 'posi_title', 'posi_issn_l', 'posi_issn_print', 'posi_issn_online']),
    'utf-8',
  )
  writeFileSync(
    join(outDir, 'coverage-candidates.csv'),
    toCsv(allCoverageCandidates, ['family', 'showjcr_journal', 'showjcr_issn', 'showjcr_eissn', 'chineseName', 'category', 'tier', 'warningReason']),
    'utf-8',
  )
  writeFileSync(
    join(outDir, 'showjcr-context-overlay.csv'),
    toCsv(allContextOverlay, ['family', 'journal', 'chineseName', 'category', 'tier', 'warningReason', 'posi_id', 'posi_title']),
    'utf-8',
  )

  const generatedAt = new Date().toISOString()
  const md = buildMarkdownReport({
    generatedAt, showjcrRepo, showjcrRef, posiDataRepo, posiDataRef,
    posiRecordCount: posiRecords.length, familySummaries,
    titleMismatches: allTitleMismatches, issnMismatches: allIssnMismatches,
    coverageCount: allCoverageCandidates.length, contextCount: allContextOverlay.length,
  })
  writeFileSync(join(outDir, 'identity-discrepancy-report.md'), md, 'utf-8')

  console.log(`\nWrote report to ${outDir}:`)
  console.log('  - identity-discrepancy-report.md')
  console.log('  - identity-discrepancies.csv')
  console.log('  - coverage-candidates.csv')
  console.log('  - showjcr-context-overlay.csv')
  console.log(`\nTotals: ${allTitleMismatches.length} title mismatches, ${allIssnMismatches.length} ISSN mismatches, ${allCoverageCandidates.length} coverage candidates, ${allContextOverlay.length} context-overlay matches.`)
}

function buildMarkdownReport({ generatedAt, showjcrRepo, showjcrRef, posiDataRepo, posiDataRef, posiRecordCount, familySummaries, titleMismatches, issnMismatches, coverageCount, contextCount }) {
  const lines = []
  lines.push('# ShowJCR identity cross-check report')
  lines.push('')
  lines.push(`Generated: ${generatedAt}`)
  lines.push(`Sources: [${showjcrRepo}@${showjcrRef}](https://github.com/${showjcrRepo}) (identity fields only — see script header for what is/isn't used and why), [${posiDataRepo}@${posiDataRef}](https://github.com/${posiDataRepo}) (${posiRecordCount} journal records)`)
  lines.push('')
  lines.push('**Scope note:** this cross-checks journal name / ISSN / EISSN only. No JCR impact')
  lines.push('factor, JCR quartile, or CAS partition tier value was fetched into a persisted')
  lines.push('field anywhere in this report or its companion CSVs — see')
  lines.push('`src/showjcr/extract.mjs` for the exact column allow-list per source family.')
  lines.push('')
  lines.push('## Per-family summary')
  lines.push('')
  lines.push('| Family | Source file | Records | Matched | Title mismatch | ISSN mismatch | Not in POSI |')
  lines.push('|---|---|---:|---:|---:|---:|---:|')
  for (const s of familySummaries) {
    lines.push(`| ${s.family} | ${s.source} | ${s.total} | ${s.matched} | ${s.titleMismatches ?? 'n/a (no ISSN in source)'} | ${s.issnMismatches ?? 'n/a (no ISSN in source)'} | ${s.notFound} |`)
  }
  lines.push('')
  lines.push(`Total identity discrepancies flagged for review: **${titleMismatches.length + issnMismatches.length}** (${titleMismatches.length} title mismatch on ISSN match, ${issnMismatches.length} ISSN mismatch on title match).`)
  lines.push(`Coverage candidates (present in ShowJCR's identity lists, not yet in POSI): **${coverageCount}** — not something to import from ShowJCR directly; these are candidates for normal OpenAlex/Crossref ingestion.`)
  lines.push(`Context-overlay matches (title-only families: CCF / CCFT / early-warning, matched to an existing POSI journal): **${contextCount}** — informational only, not a POSI-computed ranking.`)
  lines.push('')

  lines.push('## Title mismatches (ISSN matched, title disagrees)')
  lines.push('')
  lines.push('POSI\'s ISSN agrees with ShowJCR\'s, but the stored title differs — check for a')
  lines.push('typo, truncation, or stale title on the POSI side (or ShowJCR\'s side; direction')
  lines.push('isn\'t automatically known, a human needs to check).')
  lines.push('')
  if (titleMismatches.length === 0) {
    lines.push('_None found._')
  } else {
    lines.push('| Family | ShowJCR title | POSI id | POSI title |')
    lines.push('|---|---|---|---|')
    for (const m of titleMismatches.slice(0, 50)) {
      lines.push(`| ${m.family} | ${m.showjcr_journal} | ${m.posi_id} | ${m.posi_title} |`)
    }
    if (titleMismatches.length > 50) lines.push(`\n_...and ${titleMismatches.length - 50} more — see identity-discrepancies.csv._`)
  }
  lines.push('')

  lines.push('## ISSN mismatches (title matched, ISSN disagrees)')
  lines.push('')
  lines.push('The journal title matches exactly, but POSI\'s stored ISSN(s) share nothing with')
  lines.push('ShowJCR\'s ISSN/EISSN — check whether POSI has a wrong/stale ISSN.')
  lines.push('')
  lines.push('**Caution:** many short/generic English titles ("Politics", "Area", "Sophia",')
  lines.push('"Spectrum") are used by multiple unrelated journals from different countries —')
  lines.push('a title-only match on one of these is more likely a coincidence than a real')
  lines.push('POSI data error. Rows below are marked `confidence: low_generic_title` in that')
  lines.push('case; the table is sorted to show `normal`-confidence (distinctive, multi-word')
  lines.push('title) matches first, since those are the more actionable ones.')
  lines.push('')
  if (issnMismatches.length === 0) {
    lines.push('_None found._')
  } else {
    const normalCount = issnMismatches.filter(m => m.confidence === 'normal').length
    lines.push(`${normalCount} normal-confidence, ${issnMismatches.length - normalCount} low-confidence (generic title) out of ${issnMismatches.length} total.`)
    lines.push('')
    const sorted = [...issnMismatches].sort((a, b) => (a.confidence === 'normal' ? 0 : 1) - (b.confidence === 'normal' ? 0 : 1))
    lines.push('| Family | Confidence | Journal | ShowJCR ISSN/EISSN | POSI id | POSI issn_l / issn_print / issn_online |')
    lines.push('|---|---|---|---|---|---|')
    for (const m of sorted.slice(0, 50)) {
      lines.push(`| ${m.family} | ${m.confidence} | ${m.showjcr_journal} | ${m.showjcr_issn ?? ''} / ${m.showjcr_eissn ?? ''} | ${m.posi_id} | ${m.posi_issn_l ?? ''} / ${m.posi_issn_print ?? ''} / ${m.posi_issn_online ?? ''} |`)
    }
    if (sorted.length > 50) lines.push(`\n_...and ${sorted.length - 50} more — see identity-discrepancies.csv._`)
  }
  lines.push('')

  lines.push('## Coverage candidates and context overlay')
  lines.push('')
  lines.push('Full lists are in `coverage-candidates.csv` (' + coverageCount + ' rows) and')
  lines.push('`showjcr-context-overlay.csv` (' + contextCount + ' rows) — not inlined here, both')
  lines.push('can be large. Coverage candidates are not auto-imported by this script or any')
  lines.push('other; they are only pointers for the normal ingestion pipeline.')
  lines.push('')

  return lines.join('\n')
}

main().catch(err => { console.error(err); process.exit(1) })
