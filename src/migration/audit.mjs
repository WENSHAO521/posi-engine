/**
 * Audit report assembly — turns normalize/dedupe output into the file set
 * described in the dry-run migration plan. Pure functions (string/object
 * builders); the CLI script is responsible for writing files to disk.
 */

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : 'n/a'
}

function csvEscape(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows, columns) {
  const header = columns.join(',')
  const lines = rows.map(r => columns.map(c => csvEscape(Array.isArray(r[c]) ? r[c].join(';') : r[c])).join(','))
  return [header, ...lines].join('\n') + '\n'
}

/**
 * @param {object} params
 * @param {object[]} params.sourceRecords - raw migration-source.jsonl records
 * @param {object[]} params.normalizedRecords
 * @param {string[][]} params.warningsPerRecord - parallel to normalizedRecords
 * @param {{entities:object[], hardConflicts:object[], possibleDuplicates:object[]}} params.dedupe
 * @param {object} params.meta - { source_repository, source_commit, source_file, engine_commit, schema_commit, generated_at }
 */
export function buildAuditReport({ sourceRecords, normalizedRecords, warningsPerRecord, dedupe, meta }) {
  const total = sourceRecords.length
  const { entities, hardConflicts, possibleDuplicates } = dedupe

  const resolvedEntities = entities.filter(e => e.status === 'resolved')
  const unresolvedEntities = entities.filter(e => e.status === 'unresolved')
  const duplicateGroups = entities.filter(e => e.member_count > 1)

  const issnLCount = normalizedRecords.filter(r => r.issn_l).length
  const validIssnCount = normalizedRecords.filter(r => r.issn_print || r.issn_online).length
  const openalexCount = normalizedRecords.filter(r => r.openalex_source_id).length
  const publisherCount = normalizedRecords.filter(r => r.publisher).length
  const countryCount = normalizedRecords.filter(r => r.country).length
  const websiteCount = normalizedRecords.filter(r => r.website_url).length
  const doajListedCount = normalizedRecords.filter(r => r.doaj_status === 'listed').length

  const invalidIdentifiers = []
  normalizedRecords.forEach((r, i) => {
    for (const w of warningsPerRecord[i]) {
      if (w.startsWith('malformed ISSN') || w.startsWith('ISSN checksum failed')) {
        invalidIdentifiers.push({ legacy_id: r.legacy_id, warning: w })
      }
    }
  })

  const normalizationWarnings = []
  normalizedRecords.forEach((r, i) => {
    for (const w of warningsPerRecord[i]) {
      normalizationWarnings.push({ legacy_id: r.legacy_id, warning: w })
    }
  })

  const bySourceCollection = {}
  for (const r of sourceRecords) {
    bySourceCollection[r.source_collection] = (bySourceCollection[r.source_collection] ?? 0) + 1
  }

  const stats = {
    generated_at: meta.generated_at,
    mode: 'dry-run',
    source_repository: meta.source_repository,
    source_commit: meta.source_commit,
    source_file: meta.source_file,
    engine_commit: meta.engine_commit,
    schema_commit: meta.schema_commit,
    posi_j_ids_generated: 0,
    counts: {
      source_records: total,
      by_source_collection: bySourceCollection,
      candidate_entities: entities.length,
      resolved_entities: resolvedEntities.length,
      unresolved_entities: unresolvedEntities.length,
      duplicate_groups: duplicateGroups.length,
      records_absorbed_into_duplicate_groups: duplicateGroups.reduce((s, e) => s + e.member_count, 0),
      hard_conflicts: hardConflicts.length,
      possible_duplicate_groups: possibleDuplicates.length,
      invalid_identifiers: invalidIdentifiers.length,
      normalization_warnings: normalizationWarnings.length,
    },
    coverage: {
      issn_l: { count: issnLCount, pct: pct(issnLCount, total) },
      valid_issn_print_or_online: { count: validIssnCount, pct: pct(validIssnCount, total) },
      openalex_source_id: { count: openalexCount, pct: pct(openalexCount, total) },
      publisher: { count: publisherCount, pct: pct(publisherCount, total) },
      country: { count: countryCount, pct: pct(countryCount, total) },
      website_url: { count: websiteCount, pct: pct(websiteCount, total) },
      doaj_listed: { count: doajListedCount, pct: pct(doajListedCount, total) },
    },
  }

  const md = `# POSI Journal Migration — Dry Run Report

Generated: ${meta.generated_at}
Mode: **dry-run** (no POSI-J ids generated, nothing written to \`journals/\`)
Source: ${meta.source_repository}@${meta.source_commit} (\`${meta.source_file}\`)
Engine: ${meta.engine_commit}
Schema: ${meta.schema_commit}

## Summary

| Metric | Value |
|---|---|
| Source records | ${total} |
| Candidate journal entities | ${entities.length} |
| — resolved (ISSN and/or OpenAlex match) | ${resolvedEntities.length} |
| — unresolved (no strong identity signal) | ${unresolvedEntities.length} |
| Duplicate groups (2+ source records → 1 entity) | ${duplicateGroups.length} |
| Records absorbed into a duplicate group | ${stats.counts.records_absorbed_into_duplicate_groups} |
| Hard identity conflicts | ${hardConflicts.length} |
| Possible duplicates (title+publisher match, not merged) | ${possibleDuplicates.length} |
| Invalid identifiers (malformed/checksum-failed ISSN) | ${invalidIdentifiers.length} |
| Normalization warnings (all types) | ${normalizationWarnings.length} |

## Source composition

${Object.entries(bySourceCollection).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}

## Field coverage

| Field | Count | % of source records |
|---|---:|---:|
| ISSN-L | ${stats.coverage.issn_l.count} | ${stats.coverage.issn_l.pct} |
| Valid ISSN (print or online) | ${stats.coverage.valid_issn_print_or_online.count} | ${stats.coverage.valid_issn_print_or_online.pct} |
| OpenAlex Source ID | ${stats.coverage.openalex_source_id.count} | ${stats.coverage.openalex_source_id.pct} |
| Publisher | ${stats.coverage.publisher.count} | ${stats.coverage.publisher.pct} |
| Country | ${stats.coverage.country.count} | ${stats.coverage.country.pct} |
| Website URL | ${stats.coverage.website_url.count} | ${stats.coverage.website_url.pct} |
| DOAJ listed | ${stats.coverage.doaj_listed.count} | ${stats.coverage.doaj_listed.pct} |

## What this means for the identity registry priority

- **ISSN-L coverage of ${stats.coverage.issn_l.pct}** — this source has never
  distinguished ISSN-L from print/online ISSN, so tier 1 of the identity
  priority is not populated by this migration. Tier 2 (valid ISSN pair) is
  the effective primary signal for this dataset.
- **DOAJ id coverage is 0%** — this source stores \`doaj_status\` (a
  boolean-ish flag), never a DOAJ journal record id, so tier 4 does not fire
  either. Deduplication here rests on ISSN (tier 2) and OpenAlex Source ID
  (tier 3) only.

## Next steps (not part of this dry run)

1. Review \`hard-conflicts.csv\` — every row needs a human decision before
   any migration proceeds.
2. Review \`possible-duplicates.csv\` — title/publisher matches are never
   auto-merged; each is a candidate for manual review only.
3. Re-run this dry run against the same input a second time and diff the
   two \`migration-audit.json\` files — they must be byte-for-byte identical
   except for \`generated_at\` (see PJR-SPEC.md § 12's reproducibility
   requirement) before this is trusted for a real migration.
4. Only after review: assign permanent \`POSI-J-######\` ids to resolved,
   conflict-free candidate entities and commit them to \`journals/\`.
`

  return {
    stats,
    md,
    files: {
      'migration-audit.json': JSON.stringify(stats, null, 2) + '\n',
      'migration-audit.md': md,
      'candidate-entities.jsonl': entities.map(e => JSON.stringify(e)).join('\n') + '\n',
      'duplicate-groups.jsonl': duplicateGroups.map(e => JSON.stringify(e)).join('\n') + '\n',
      'possible-duplicates.csv': toCsv(possibleDuplicates, ['title', 'publisher', 'legacy_ids', 'candidate_entities']),
      'hard-conflicts.csv': toCsv(
        hardConflicts.map(c => ({ ...c, legacy_ids: c.legacy_ids, conflicting_issn_sets: c.conflicting_issn_sets.map(s => s.join('|')).join(' vs ') })),
        ['type', 'openalex_source_id', 'legacy_ids', 'conflicting_issn_sets']
      ),
      'invalid-identifiers.csv': toCsv(invalidIdentifiers, ['legacy_id', 'warning']),
      'unresolved-records.jsonl': unresolvedEntities.map(e => JSON.stringify(e)).join('\n') + '\n',
      'normalization-warnings.csv': toCsv(normalizationWarnings, ['legacy_id', 'warning']),
    },
  }
}
