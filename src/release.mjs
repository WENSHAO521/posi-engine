/**
 * PJR release assembly — implements posi-data/PJR-SPEC.md § 1–3.
 *
 * Pure functions only: given already-computed journal/metric/ranking data
 * and provenance identifiers, build the exact manifest.json shape § 2
 * defines and the release asset filename list § 3 defines. This module
 * does NOT tag a commit, upload assets, or call the GitHub Releases API —
 * publishing a real PJR release is a deliberate, separate, human-triggered
 * step (a GitHub Actions workflow or a manually-run script that imports
 * this module), never a side effect of computing a manifest. See this
 * repo's README for the full intended flow.
 */

export const RELEASE_ASSET_FILENAMES = [
  'manifest.json',
  'SHA256SUMS',
  'posi-journals-{release}.jsonl.gz',
  'posi-classifications-{release}.csv.gz',
  'posi-metrics-{release}.csv.gz',
  'posi-rankings-{release}.csv.gz',
]

/**
 * @param {string} release - e.g. "PJR-2028.1"
 * @returns {string[]} the § 3 asset filenames with `{release}` substituted
 */
export function releaseAssetFilenames(release) {
  return RELEASE_ASSET_FILENAMES.map(f => f.replace('{release}', release))
}

/**
 * @param {number} metricYear
 * @returns {string} "PJR-{metric_year + 1}.1" — the normal (non-revision) release name for a metric_year
 */
export function defaultReleaseName(metricYear) {
  return `PJR-${metricYear + 1}.1`
}

/**
 * Builds the manifest.json object described in PJR-SPEC.md § 2. Every field
 * is required on the input side (no silent defaulting of a provenance
 * field to a placeholder) except `supersedes`, which is `null` unless this
 * is a corrected re-issue (§ 7).
 *
 * @param {object} params
 * @param {string} params.release - e.g. "PJR-2028.1". Must match
 *   `PJR-{metric_year+1}.{revision}` unless `allowNonStandardName` is set
 *   (a revision release for a still-in-year correction is the one case
 *   `metric_year + 1` doesn't hold at publish time — see § 7).
 * @param {number} params.metric_year
 * @param {string} params.data_cutoff - ISO date, e.g. "2027-12-31"
 * @param {string} params.released - ISO date this release is actually published
 * @param {string} params.psc_version
 * @param {string} params.pci_methodology_version
 * @param {string} params.ranking_methodology_version
 * @param {string} params.data_commit - posi-data git SHA the release was generated from
 * @param {string} params.engine_commit - posi-engine git SHA used to generate it
 * @param {object[]} params.journals - every journal record considered for this release
 * @param {object[]} params.metrics - metric snapshots for `metric_year`, one per journal
 * @param {string[]} params.categoryCodes - every distinct PSC category code touched by this release's rankings
 * @param {string|null} [params.supersedes] - prior release name, only for a corrected re-issue
 * @returns {object} the manifest.json shape
 */
export function buildManifest(params) {
  const {
    release, metric_year, data_cutoff, released,
    psc_version, pci_methodology_version, ranking_methodology_version,
    data_commit, engine_commit,
    journals, metrics, categoryCodes,
    supersedes = null,
  } = params

  const required = { release, metric_year, data_cutoff, released, psc_version, pci_methodology_version, ranking_methodology_version, data_commit, engine_commit }
  for (const [key, value] of Object.entries(required)) {
    if (value == null || value === '') throw new Error(`buildManifest: missing required field "${key}"`)
  }
  if (!Array.isArray(journals)) throw new Error('buildManifest: journals must be an array')
  if (!Array.isArray(metrics)) throw new Error('buildManifest: metrics must be an array')

  const metricEligibleCount = metrics.filter(m => m.status === 'active' || m.status === 'suppressed').length

  return {
    release,
    metric_year,
    data_cutoff,
    released,
    psc_version,
    pci_methodology_version,
    ranking_methodology_version,
    data_commit,
    engine_commit,
    journal_count: journals.length,
    metric_eligible_journal_count: metricEligibleCount,
    category_count: new Set(categoryCodes ?? []).size,
    supersedes,
  }
}

/**
 * SHA256SUMS file content — one "<hex digest>  <filename>" line per asset,
 * matching the conventional `sha256sum` output format so `sha256sum -c
 * SHA256SUMS` verifies it directly. Pure string assembly; the caller
 * supplies already-computed digests (this module does no file I/O or
 * hashing itself).
 * @param {{ filename: string, sha256: string }[]} assets
 * @returns {string}
 */
export function buildShasumsFile(assets) {
  return assets.map(a => `${a.sha256}  ${a.filename}`).join('\n') + '\n'
}

/**
 * Validates a manifest object against the § 2 shape and a few cross-field
 * sanity rules that a hand-built manifest could otherwise violate silently
 * (e.g. metric_eligible_journal_count larger than journal_count).
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = []
  const requiredFields = [
    'release', 'metric_year', 'data_cutoff', 'released', 'psc_version',
    'pci_methodology_version', 'ranking_methodology_version',
    'data_commit', 'engine_commit', 'journal_count',
    'metric_eligible_journal_count', 'category_count', 'supersedes',
  ]
  for (const field of requiredFields) {
    if (!(field in manifest)) errors.push(`missing field: ${field}`)
  }
  if (manifest.metric_eligible_journal_count > manifest.journal_count) {
    errors.push('metric_eligible_journal_count cannot exceed journal_count')
  }
  if (typeof manifest.release === 'string' && !/^PJR-\d{4}\.\d+$/.test(manifest.release)) {
    errors.push(`release "${manifest.release}" does not match PJR-{year}.{revision} shape`)
  }
  return { valid: errors.length === 0, errors }
}
