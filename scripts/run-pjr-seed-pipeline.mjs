#!/usr/bin/env node
/**
 * run-pjr-seed-pipeline.mjs
 *
 * Orchestrates the full pjr-seed-corpus-1000 pipeline end-to-end over the
 * global-benchmark corpus + its OpenAlex source/works data (see
 * fetch-pjr-source-data.mjs's output):
 *
 *   1. Normalize + dedupe-audit the corpus (normalize.mjs, dedupe.mjs,
 *      audit.mjs) -> a dry-run identity audit, written to posi-data's
 *      audits/migrations/benchmark-corpus-seed/.
 *   2. Mint POSI-J ids for every resolved, conflict-free entity
 *      (mint.mjs), against the existing registry — never re-minting an id
 *      that already resolves. Writes registry/journal-id-map.csv +
 *      journals/discovered/*.jsonl.
 *   3. Compute PCI / PCI-5 / PNCI per journal (pci.mjs +
 *      openalex-document-type.mjs's type crosswalk) from the fetched
 *      works. Writes metrics/<year>/<shard>/<id>.json (sharding.mjs).
 *   4. Run the citation-integrity checks that are actually computable from
 *      this pass's data (citationConcentration — concentration within a
 *      journal's own articles; suddenCitationSpike is skipped, see the
 *      script's own summary output, since it needs 2+ years of metric
 *      history and this is the first year computed at all).
 *   5. Rank within each high-confidence PSC category (ranking.mjs,
 *      MIN_CATEGORY_SIZE gate). Writes rankings/<year>/<shard>/<id>.json.
 *   6. Assemble (but do not publish) a manifest.json via release.mjs,
 *      clearly marked as a non-official test/seed computation.
 *
 * This is NOT a real PJR release. It does not tag anything, does not call
 * the GitHub Releases API, and status fields are set honestly
 * (journal.status: "discovered" — these are OpenAlex-signal benchmark
 * journals, never reviewed for POSI Core Collection admission; see
 * posi-data/corpus/README.md).
 *
 * --- Mapping to the "POSI Journal Evaluation & Ranking Framework 1.0"
 * --- 15-step pipeline order (documentation only — this script's own
 * --- numbered steps above are unchanged; this note says which framework
 * --- steps this OpenAlex-metrics-only run does and does not cover):
 *
 *   01 Identity Resolution         -> this script's step 1-2 (normalize/dedupe/mint)
 *   02 Coverage/PQF                -> NOT run here — this corpus's journals are
 *                                     status:"discovered" benchmark records, never
 *                                     evaluated for Core Collection admission (see
 *                                     src/pqf.mjs for the admission-only output
 *                                     contract that would apply to a real PCC run)
 *   03 Evidence Resolver           -> NOT run here — no site-crawl evidence exists
 *                                     for this corpus; AJR-E/AJR-M need that ETL
 *                                     step, which is separate and out of scope for
 *                                     an OpenAlex-only metrics pass (see README)
 *   04 First Publication Date      -> NOT run here — same reason (no publisher/
 *                                     Crossref-article-level evidence fetched);
 *                                     see src/first-publication-date.mjs, unused
 *                                     by this script today
 *   05 Lifecycle Classification    -> NOT run here — depends on 04
 *   06 PSC Classification          -> covered upstream (classify-psc.mjs style
 *                                     classification, see corpus/README.md);
 *                                     confidence gating happens at this script's
 *                                     step 5 (`m.confidence !== 'high'`)
 *   07 Evidence Coverage           -> NOT run here — depends on 03
 *   08 AJR-E/AJR-M                 -> NOT run here — depends on 03/05/07. AJR-M's
 *                                     Citation Performance dimension DOES consume
 *                                     this script's PCI/PCI-5 output once real
 *                                     evidence flows through a future evidence-
 *                                     resolver-backed run — see src/ajr-mature.mjs
 *   09 PCI/PCI-5/PNCI               -> this script's step 3-4
 *   10 Citation Integrity           -> this script's step 4 (partial — see its
 *                                      own note: only citationConcentration runs
 *                                      this pass, real citation-edge data would
 *                                      be needed for self-citation/stacking/
 *                                      cartel/publisher-clustering)
 *   11 Eligibility Gates            -> the confidence >= high gate at step 5 is
 *                                      the one eligibility gate this pass applies
 *   12 Rank/Midrank/Percentile      -> this script's step 5 (ranking.mjs, i.e.
 *                                      the Citation Q track specifically — see
 *                                      src/quartile-tracks.mjs's rankCitationTrack)
 *   13 E-Q/M-Q/Citation Q           -> only Citation Q is produced (no AJR-E/
 *                                      AJR-M scores exist yet to feed E-Q/M-Q)
 *   14 Frozen Release               -> this script's step 6 (non-official manifest)
 *   15 Verification                 -> scripts/validate-against-schema.mjs (run
 *                                      separately, not invoked by this script)
 *
 * Usage:
 *   node scripts/run-pjr-seed-pipeline.mjs \
 *     --corpus path/to/global-benchmark.json \
 *     --source-data path/to/pjr-source-data.json \
 *     --posi-data-dir path/to/posi-data-checkout \
 *     --metric-year 2025
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { normalizeRecord } from '../src/migration/normalize.mjs'
import { buildCandidateEntities } from '../src/migration/dedupe.mjs'
import { buildAuditReport } from '../src/migration/audit.mjs'
import { buildRegistryIndex, nextSequenceNumber, resolveOrMintIds } from '../src/migration/mint.mjs'
import { calculatePci, calculatePci5, calculateCategoryBaseline, calculatePnci, PCI_METHODOLOGY_VERSION } from '../src/pci.mjs'
import { mapOpenAlexType } from '../src/openalex-document-type.mjs'
import { citationConcentration } from '../src/citation-integrity.mjs'
import { rankCategory, RANKING_METHODOLOGY_VERSION, MIN_CATEGORY_SIZE } from '../src/ranking.mjs'
import { buildManifest, validateManifest } from '../src/release.mjs'
import { shardFor, journalCorePath, metricPath, rankingPath } from '../src/sharding.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

function ensureDirFor(filePath) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function writeJson(filePath, obj) {
  ensureDirFor(filePath)
  writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
}

function yearCitations(counts_by_year, year) {
  const entry = (counts_by_year ?? []).find(c => c.year === year)
  return entry ? entry.cited_by_count : 0
}

function toMigrationSourceRecord(j) {
  return {
    source_collection: 'global_benchmark',
    legacy_id: j.journal_code,
    title: j.title,
    short_title: j.short_title,
    issn_print: j.issn_print,
    issn_online: j.issn_online,
    issn_l: null, // filled in from OpenAlex source data below, not present on the corpus record itself
    publisher: j.publisher,
    country: j.country,
    website_url: j.website_url,
    openalex_source_id: j.openalex_source_id,
    doaj_status: j.doaj_status,
    doaj_id: null,
    article_count: j.article_count,
  }
}

async function main() {
  const corpusPath = arg('corpus')
  const sourceDataPath = arg('source-data')
  const posiDataDir = resolve(arg('posi-data-dir', '../posi-data'))
  const metricYear = parseInt(arg('metric-year', '2025'), 10)
  const dataCutoff = `${metricYear}-12-31`
  const today = new Date().toISOString().slice(0, 10)
  const nowIso = new Date().toISOString()

  // posi-data/CONTRIBUTING.md is explicit: "Manual edits to metrics/ or
  // rankings/ ... are generated by posi-engine and are only ever updated
  // by its release workflow" — this repo has no such automated release
  // workflow yet (no .github/workflows exist), so this script does NOT
  // write into the canonical metrics/<year>/ or rankings/<year>/ trees via
  // a manually-reviewed PR, even though it computes exactly that shape of
  // data. Instead metrics/rankings output lands under this audit
  // directory's own sample-output/, using the identical shard layout
  // (sharding.mjs), so a human reviewer — or a real future engine-driven
  // workflow — can inspect or promote it deliberately, rather than this
  // script silently establishing manual-PR-writes-metrics as a precedent.
  // journals/discovered/ and registry/journal-id-map.csv are NOT covered
  // by that CONTRIBUTING.md restriction (it names metrics/ and rankings/
  // specifically) and are written to their real canonical locations below.
  const metricsRankingsRoot = resolve(arg('metrics-rankings-output-dir', join(posiDataDir, 'audits', 'migrations', 'benchmark-corpus-seed', 'sample-output')))

  if (!corpusPath || !sourceDataPath) {
    console.error('Usage: node scripts/run-pjr-seed-pipeline.mjs --corpus <global-benchmark.json> --source-data <pjr-source-data.json> --posi-data-dir <path>')
    process.exit(1)
  }

  const corpus = JSON.parse(readFileSync(resolve(corpusPath), 'utf-8'))
  const sourceData = JSON.parse(readFileSync(resolve(sourceDataPath), 'utf-8'))
  const sourceByCode = new Map(sourceData.journals.map(j => [j.journal_code, j]))
  console.log(`Loaded ${corpus.length} corpus journals, ${sourceData.journals.length} source-data records (metric_year ${sourceData.metric_year}).`)

  // ---------- 1. Normalize + dedupe audit ----------
  const sourceRecords = corpus.map(toMigrationSourceRecord)
  // Fill issn_l from the live OpenAlex source lookup before normalizing,
  // so normalize.mjs/identity.mjs see the real issn_l this corpus's own
  // fields never carried (see corpus/README.md).
  for (const rec of sourceRecords) {
    const sd = sourceByCode.get(rec.legacy_id)
    if (sd?.source?.issn_l) rec.issn_l = sd.source.issn_l
  }

  const normalizedRecords = []
  const warningsPerRecord = []
  for (const rec of sourceRecords) {
    const { normalized, warnings } = normalizeRecord(rec)
    normalizedRecords.push(normalized)
    warningsPerRecord.push(warnings)
  }

  const dedupe = buildCandidateEntities(normalizedRecords)
  console.log(`Identity resolution: ${dedupe.entities.length} candidate entities, ${dedupe.hardConflicts.length} hard conflicts, ${dedupe.possibleDuplicates.length} possible-duplicate groups.`)

  const auditOutDir = join(posiDataDir, 'audits', 'migrations', 'benchmark-corpus-seed')
  const auditReport = buildAuditReport({
    sourceRecords,
    normalizedRecords,
    warningsPerRecord,
    dedupe,
    meta: {
      source_repository: 'WENSHAO521/posi-data',
      source_commit: arg('source-commit', 'unknown'),
      source_file: 'corpus/global-benchmark.json',
      generator_commit: arg('generator-commit', 'unknown'),
      spec_commit: arg('spec-commit', 'unknown'),
      generated_at: nowIso,
    },
  })
  if (!existsSync(auditOutDir)) mkdirSync(auditOutDir, { recursive: true })
  for (const [filename, content] of Object.entries(auditReport.files)) {
    writeFileSync(join(auditOutDir, filename), content, 'utf-8')
  }
  console.log(`Wrote dry-run identity audit to ${auditOutDir}`)

  // ---------- 2. Mint POSI-J ids (only for resolved, conflict-free entities) ----------
  const conflictedLegacyIds = new Set(dedupe.hardConflicts.flatMap(c => c.legacy_ids))
  const registryPath = join(posiDataDir, 'registry', 'journal-id-map.csv')
  const existingRegistryText = readFileSync(registryPath, 'utf-8')
  const existingRegistryRows = existingRegistryText.trim().split('\n').slice(1).filter(Boolean).map(line => {
    const [posi_id, identity_type, identity_value, first_seen] = line.split(',')
    return { posi_id, identity_type, identity_value, first_seen }
  })
  const registryIndex = buildRegistryIndex(existingRegistryRows)
  const startSeq = nextSequenceNumber(existingRegistryRows)

  const resolvedEntities = dedupe.entities.filter(e => e.status === 'resolved' && !e.member_legacy_ids.some(id => conflictedLegacyIds.has(id)))
  const entitiesWithIssnL = resolvedEntities.map(e => {
    const legacyId = e.member_legacy_ids[0]
    const sd = sourceByCode.get(legacyId)
    return { ...e, issn_l: sd?.source?.issn_l ?? null }
  })

  const { assignments, newRegistryRows, unresolved } = resolveOrMintIds(entitiesWithIssnL, registryIndex, startSeq, today)
  console.log(`Minted ${newRegistryRows.length} new POSI-J ids (${assignments.length} total resolved assignments, ${unresolved.length} unresolved, ${conflictedLegacyIds.size} excluded for hard identity conflicts).`)

  if (newRegistryRows.length > 0) {
    const csvLines = newRegistryRows.map(r => `${r.posi_id},${r.identity_type},${r.identity_value},${r.first_seen}`)
    appendFileSync(registryPath, csvLines.join('\n') + '\n', 'utf-8')
  }

  const posiIdByLegacyId = new Map()
  for (const a of assignments) {
    const entity = entitiesWithIssnL.find(e => e.candidate_id === a.candidate_id)
    for (const legacyId of entity.member_legacy_ids) posiIdByLegacyId.set(legacyId, a.posi_id)
  }

  // ---------- 3. Build journal records (status: "discovered" — see module header) ----------
  const journalRecords = []
  for (const j of corpus) {
    const posiId = posiIdByLegacyId.get(j.journal_code)
    if (!posiId) continue // unresolved or conflicted — excluded from this pass, left for manual review
    const sd = sourceByCode.get(j.journal_code)
    journalRecords.push({
      id: posiId,
      title: j.title,
      short_title: j.short_title || null,
      status: 'discovered',
      publisher: j.publisher || null,
      country: j.country || null,
      language: j.language ? [j.language] : null,
      open_access: j.open_access ?? null,
      license: j.license || null,
      website_url: j.website_url || null,
      identifiers: {
        issn_l: sd?.source?.issn_l ?? null,
        issn_print: j.issn_print || null,
        issn_online: j.issn_online || null,
        openalex_source_id: j.openalex_source_id || null,
        crossref_member_id: null,
        ror_publisher_id: null,
        doaj_id: null,
      },
      classification: j.psc_category ? {
        primary: j.psc_category,
        secondary: [],
        psc_version: '1.0.0',
        // BUG FIX: this corpus record's own psc_confidence was computed
        // (see corpus/README.md) but was never carried through into the
        // written journal record's classification block — schema/
        // journal.schema.json didn't have a field for it until the
        // "POSI Journal Evaluation & Ranking Framework 1.0" rollout added
        // classification.psc_confidence. Without this, every discovered
        // journal record silently lost its 4-state PSC-CROSSWALK-0.2
        // confidence, which src/cohort.mjs's ranking-eligibility gate
        // depends on.
        psc_confidence: j.psc_confidence ?? null,
        assigned_by: 'ml_suggested_pending_review',
        assigned_at: today,
      } : null,
      coverage: null,
      selection: null,
      provenance: [
        // OpenAlex's own data is released under CC0 1.0 (public domain
        // dedication) — see https://docs.openalex.org/ - "About the data",
        // which is why posi-data/LICENSE-DATA can point a reader at
        // journals/*'s own provenance[].license for upstream-sourced
        // records instead of claiming CC BY 4.0 over data POSI didn't itself produce.
        { source: 'openalex', source_record_id: j.openalex_source_id, retrieved_at: nowIso, license: 'CC0-1.0' },
      ],
      created_at: nowIso,
      updated_at: nowIso,
    })
  }

  const discoveredDir = join(posiDataDir, 'journals', 'discovered')
  if (!existsSync(discoveredDir)) mkdirSync(discoveredDir, { recursive: true })
  const jsonlPath = join(discoveredDir, `global-benchmark-seed-${metricYear}.jsonl`)
  writeFileSync(jsonlPath, journalRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
  console.log(`Wrote ${journalRecords.length} journal records to ${jsonlPath}`)

  // ---------- 4. Compute PCI / PCI-5 per journal ----------
  const perJournalMetrics = [] // { posiId, category, confidence, pci2, pci5, capped, works2yrCount }
  const integrityNotes = []

  for (const j of corpus) {
    const posiId = posiIdByLegacyId.get(j.journal_code)
    if (!posiId) continue
    const sd = sourceByCode.get(j.journal_code)
    if (!sd || !sd.source) continue

    const works = sd.works ?? []
    const mapped = works.map(w => ({
      document_type: mapOpenAlexType(w.type),
      citations_in_year: yearCitations(w.counts_by_year, metricYear),
      publication_year: w.publication_year,
      work_id: w.id,
    }))

    const works2yr = mapped.filter(w => w.publication_year >= metricYear - 2 && w.publication_year <= metricYear - 1)
    const pci2Raw = calculatePci(works2yr)
    const pci5Raw = calculatePci5(mapped)

    // Denominator is the EXACT OpenAlex meta.count (never capped); numerator
    // is whatever the (possibly page-capped) fetch actually retrieved. See
    // fetch-pjr-source-data.mjs's header for why sort=publication_date:desc
    // makes the 2-year window far more likely to be complete even when
    // capped.
    const citableItems2yr = sd.citable_items_2yr_exact ?? pci2Raw.citable_items
    const citableItems5yr = sd.citable_items_5yr_exact ?? pci5Raw.citable_items
    const pci2 = { ratio: citableItems2yr > 0 ? pci2Raw.citation_count / citableItems2yr : null, citable_items: citableItems2yr, citation_count: pci2Raw.citation_count }
    const pci5 = { ratio: citableItems5yr > 0 ? pci5Raw.citation_count / citableItems5yr : null, citable_items: citableItems5yr, citation_count: pci5Raw.citation_count }

    const concentration = citationConcentration(works2yr.map(w => ({ work_id: w.work_id, citations_in_year: w.citations_in_year })))
    if (concentration.flagged) {
      integrityNotes.push({ journal_id: posiId, journal_code: j.journal_code, check: 'concentration', top1_share: concentration.top1_share, top3_share: concentration.top3_share })
    }

    perJournalMetrics.push({
      posiId,
      journalCode: j.journal_code,
      category: j.psc_category ?? null,
      confidence: j.psc_confidence ?? null,
      pci2,
      pci5,
      capped: !!sd.numerator_capped,
      totalCitations: sd.source?.cited_by_count ?? 0,
      concentrationFlagged: concentration.flagged,
      concentration,
    })
  }
  console.log(`Computed PCI/PCI-5 for ${perJournalMetrics.length} journals. ${integrityNotes.length} flagged by citationConcentration.`)

  // ---------- 5. PNCI category baselines (high-confidence categories only) ----------
  const byCategory = new Map()
  for (const m of perJournalMetrics) {
    if (m.confidence !== 'high' || !m.category || m.pci2.citable_items === 0) continue
    if (!byCategory.has(m.category)) byCategory.set(m.category, [])
    byCategory.get(m.category).push(m)
  }
  const baselineByCategory = new Map()
  for (const [category, entries] of byCategory) {
    baselineByCategory.set(category, calculateCategoryBaseline(entries.map(e => e.pci2)))
  }
  console.log(`Computed category baselines for ${baselineByCategory.size} distinct high-confidence PSC categories.`)

  // ---------- 6. Write metric records ----------
  let activeCount = 0, suppressedCount = 0, insufficientCount = 0
  const metricRecords = []
  for (const m of perJournalMetrics) {
    const baseline = m.confidence === 'high' && m.category ? baselineByCategory.get(m.category) : null
    const pnci = baseline ? calculatePnci(m.pci2.ratio, baseline) : null

    let status = 'active'
    let suppressionReason = null
    if (m.pci2.citable_items === 0) {
      status = 'insufficient_data'
      insufficientCount++
    } else if (m.concentrationFlagged) {
      status = 'suppressed'
      suppressionReason = `citation_concentration: top-cited article(s) account for ${(m.concentration.top1_share * 100).toFixed(1)}% of this journal's ${metricYear} citations to its ${metricYear - 2}-${metricYear - 1} citable items (review flag, not a confirmed integrity violation — see PJR-SPEC.md Sec 9)`
      suppressedCount++
    } else {
      activeCount++
    }

    const metricRecord = {
      journal_id: m.posiId,
      metric_year: metricYear,
      pci: m.pci2.ratio,
      pci_5yr: m.pci5.ratio,
      pnci,
      citable_items: m.pci2.citable_items,
      citation_count: m.pci2.citation_count,
      total_citations: m.totalCitations,
      self_citation_rate: null, // not computed this pass — no citation-edge dataset yet, see README
      international: null,
      status,
      suppression_reason: suppressionReason,
      methodology_version: PCI_METHODOLOGY_VERSION,
      data_cutoff: dataCutoff,
      snapshot_date: today,
      pjr_release: null,
    }
    metricRecords.push(metricRecord)
    writeJson(join(metricsRankingsRoot, metricPath(m.posiId, metricYear)), metricRecord)
  }
  console.log(`Wrote ${perJournalMetrics.length} metric snapshots: ${activeCount} active, ${suppressedCount} suppressed, ${insufficientCount} insufficient_data.`)

  // ---------- 7. Ranking ----------
  const rankingsByCategory = new Map()
  for (const m of perJournalMetrics) {
    if (m.confidence !== 'high' || !m.category || m.pci2.ratio == null) continue
    if (!rankingsByCategory.has(m.category)) rankingsByCategory.set(m.category, [])
    rankingsByCategory.get(m.category).push({ journal_id: m.posiId, pci: m.pci2.ratio })
  }

  const rankingRecordsByJournal = new Map()
  let categoriesRanked = 0, categoriesUnavailable = 0
  for (const [category, entries] of rankingsByCategory) {
    const records = rankCategory(entries, { category_code: category, metric_year: metricYear })
    if (records[0]?.ranking_method === 'pci_midrank') categoriesRanked++
    else categoriesUnavailable++
    for (const r of records) {
      const withRelease = { ...r, pjr_release: null }
      if (!rankingRecordsByJournal.has(r.journal_id)) rankingRecordsByJournal.set(r.journal_id, [])
      rankingRecordsByJournal.get(r.journal_id).push(withRelease)
    }
  }
  for (const [posiId, records] of rankingRecordsByJournal) {
    writeJson(join(metricsRankingsRoot, rankingPath(posiId, metricYear)), records)
  }
  console.log(`Ranking: ${categoriesRanked} categories reached MIN_CATEGORY_SIZE=${MIN_CATEGORY_SIZE} and got quartiles; ${categoriesUnavailable} categories were below it (ranking_method: "unavailable"). Wrote ${rankingRecordsByJournal.size} per-journal ranking files.`)

  // ---------- 8. Manifest (test/seed run — NOT a real PJR release) ----------
  // release name follows the real PJR-{year+1}.{revision} shape so
  // validateManifest() (which checks that shape) passes — the "this is not
  // an official release" signal lives in `_note` below (manifests/
  // EXAMPLE-manifest.json in posi-data uses the same _note convention),
  // not in a deliberately-malformed release string.
  const manifest = buildManifest({
    release: `PJR-${metricYear + 1}.1`,
    metric_year: metricYear,
    data_cutoff: dataCutoff,
    released: today,
    psc_version: '1.0.0',
    pci_methodology_version: PCI_METHODOLOGY_VERSION,
    ranking_methodology_version: RANKING_METHODOLOGY_VERSION,
    data_commit: arg('data-commit', 'unknown'),
    engine_commit: arg('engine-commit', 'unknown'),
    journals: journalRecords,
    metrics: metricRecords,
    categoryCodes: [...byCategory.keys()],
    supersedes: null,
  })
  const manifestValidation = validateManifest(manifest)
  const manifestOut = {
    _note: 'TEST / SEED-CORPUS COMPUTATION ONLY — this is NOT a published PJR release. It was generated by the pjr-seed-corpus-1000 pipeline run over corpus/global-benchmark.json (an OpenAlex-signal benchmark corpus, never a POSI Core Collection admission candidate — see corpus/README.md). No GitHub Release has been tagged. See audits/migrations/benchmark-corpus-seed/README.md for what this run does and does not establish.',
    ...manifest,
  }
  writeJson(join(auditOutDir, 'manifest.json'), manifestOut)
  console.log(`Manifest valid: ${manifestValidation.valid}. journal_count=${manifest.journal_count}, metric_eligible_journal_count=${manifest.metric_eligible_journal_count}, category_count=${manifest.category_count}`)

  // ---------- 9. Pipeline summary (for the audit dir + PR description) ----------
  const cappedJournals = perJournalMetrics.filter(m => m.capped)
  const summary = {
    generated_at: nowIso,
    metric_year: metricYear,
    corpus_size: corpus.length,
    entities_resolved: resolvedEntities.length,
    posi_j_ids_minted: newRegistryRows.length,
    posi_j_ids_reused: assignments.length - newRegistryRows.length,
    unresolved_identity_count: unresolved.length,
    hard_conflict_count: dedupe.hardConflicts.length,
    metrics_written: perJournalMetrics.length,
    metric_status_counts: { active: activeCount, suppressed: suppressedCount, insufficient_data: insufficientCount },
    citation_integrity: {
      concentration_checked: perJournalMetrics.length,
      concentration_flagged: integrityNotes.length,
      self_citation_rate: 'not run this pass — needs citation-edge (journal-to-journal) data not collected here',
      citation_stacking: 'not run this pass — same reason',
      publisher_citation_cluster: 'not run this pass — same reason',
      sudden_citation_spike: 'not run this pass — needs 2+ years of metric history; this is the first year computed',
      citation_cartel: 'not run this pass — same reason as self-citation/stacking',
    },
    ranking: {
      distinct_high_confidence_categories_with_data: byCategory.size,
      categories_reaching_min_category_size: categoriesRanked,
      categories_below_min_category_size: categoriesUnavailable,
      min_category_size: MIN_CATEGORY_SIZE,
    },
    coverage: {
      journals_with_capped_works_fetch: cappedJournals.length,
      capped_journal_codes: cappedJournals.map(m => m.journalCode),
    },
    flagged_for_review: integrityNotes,
  }
  writeJson(join(auditOutDir, 'pipeline-summary.json'), summary)
  console.log(`\nWrote pipeline summary to ${join(auditOutDir, 'pipeline-summary.json')}`)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
