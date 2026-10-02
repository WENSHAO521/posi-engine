# posi-engine

The calculation engine of **POSI (Panorama Open Scholarly Index)**. It
harvests the global journal index, computes every POSI indicator, rating and
ranking, and publishes the results as GitHub releases that
[posi-data](https://github.com/WENSHAO521/posi-data) imports. It has no
database of its own; posi-data is the canonical store.

Every formula is a pure function of documented inputs, so a published number
can be reproduced from the posi-data commit and engine commit recorded with it.

## POSI Journal Evaluation Architecture 1.0

The engine implements five separate evaluation layers
([POSI-EVAL-1.0-SPEC.md](https://github.com/WENSHAO521/posi-data/blob/master/POSI-EVAL-1.0-SPEC.md)).
All of their rules live in one module, `src/evaluation.mjs`:

| Layer | Output | Rule |
|---|---|---|
| PQF | score 0–100 + status | `getPQFStatus`: ≥ 70 Eligible, 50–69.99 Review Required, 40–49.99 Insufficient Evidence, < 40 Not Eligible |
| AJR | AJR Score + AJR Rating | `getAJRRating`: A+ ≥ 90, A ≥ 85, A− ≥ 80, B+ ≥ 75, B ≥ 70, B− ≥ 65, C+ ≥ 60, C ≥ 50, D |
| Citation indicators | PCI, PNCI, PCS | `pci.mjs`, `pnci.mjs`, `pcs.mjs` |
| Citation Ranking | rank, percentile, Citation Quartile | PNCI within the PSC category; `calculateMidRank`, `calculatePercentile`, `calculateCitationQuartile` (≥ 75 / 50 / 25) |
| POSI Zones | Zone 1–4 | `calculatePOSIZone` (≥ 95 / 80 / 50) on the same percentile |

Ranking status (`getCitationRankingStatus`, `getRankingOutputs`): an official
ranking needs ≥ 20 eligible items over ≥ 2 publication years and ≥ 90%
citation coverage; 10–19 items is provisional. A category needs ≥ 20 ranked
journals for quartiles; 30–49 gives provisional zones, ≥ 50 official zones.
Tied PNCI values share rank, percentile, quartile and zone.

## PNCI-1.0

```
PNCI_j = (1 / n_j) × Σ C_i / E(field_i, year_i, type_i)
```

Item-level: each eligible item's Crossref citation count divided by the mean
of all items of the same PSC field, publication year and document type,
falling back to field × year when that group has fewer than 50 items
(`src/pnci.mjs`; [PNCI-1.0-SPEC.md](https://github.com/WENSHAO521/posi-data/blob/master/PNCI-1.0-SPEC.md)).

## The yearly global cycle

`.github/workflows/global-index.yml` builds the ranking once a year: it runs
on the 1st–3rd of December, so the edition is published at the start of
December, and resumes where it stopped (state in the actions cache):

| Stage | What | Script |
|---|---|---|
| harvest | OpenAlex snapshot + Crossref journal list | `scripts/global/harvest-*.mjs` |
| corpus | merged global corpus (~158,000 journals) | `scripts/global/build-global-corpus.mjs` |
| pcs | every eligible work of every journal, 16 shards: PCS values + per-item citation cells | `scripts/run-pcs-etl.mjs` |
| rank | Citation Ranking edition (PNCI-1.0) and PCS edition | `scripts/run-citation-ranking.mjs`, `scripts/run-pcs-q.mjs` |
| release | quality gate, then a GitHub release | `scripts/global/check-edition.mjs`, `release-edition.sh` |

The release `global-index-<cycle>` carries `global-corpus.json.gz`,
`openalex-profiles.jsonl.gz`, `citation-ranking-<Y>.json/.csv`, the PCS
edition and summaries; posi-data's `import-global-index` workflow imports it.

`check-edition.mjs` refuses a release that breaks an evaluation invariant
(`src/citation-ranking-check.mjs`): an official ranking without PNCI,
category, rank, percentile or quartile; a 50+ category without official
zones; a quartile or zone that disagrees with its percentile; tied PNCI values
with different ranks.

New journals do not wait for December: `.github/workflows/journal-directory.yml`
runs on the 4th–6th of every month (`scripts/global/refresh-directory.mjs`),
harvests the journal lists again and releases `journals-<YYYY-MM>` with the
corpus and OpenAlex profiles only. The site uses the newest `journals-*` or
`global-index-*` release; posi-data imports only `global-index-*` rankings.
A month whose corpus a `global-index-*` release already carries is skipped.

A run that stops at its time budget with work left starts the next run
itself (`scripts/global/continue-run.sh`), which resumes from the cached work
directory: for PCS only after a run that raised the number of journals done,
and at most 12 runs in a row (4 for a harvest); otherwise it opens an alert.

Workflow inputs: `pnci_backfill` reopens the current cycle, refetches the
journals whose results predate PNCI-1.0 and rebuilds the rankings;
`recheck_issns` rechecks multi-ISSN journals; `force_release` releases after a
failed check has been reviewed.

## The monthly AJR rerate

`.github/workflows/ajr-rerate.yml` re-rates the Core Collection on the 7th of
every month, after the journal directory, so lifecycle stages and AJR scores
follow the calendar:

| Step | What | Script |
|---|---|---|
| evidence | site crawl and article sample of every journal; yearly output of Mature journals (OpenAlex) | `run-evidence-etl.mjs`, `run-works-etl.mjs`, `run-output-history-etl.mjs` |
| apply | a fresh file replaces the stored one in posi-data `evidence/` only if its source was reached; a run that reached nothing fails | `apply-evidence-refresh.mjs` |
| AJR-E | `early_stage_rating` for Early-Stage journals, `not_applicable` with the current stage otherwise | `rerate-core-collection-ajr-e-1.1.mjs` |
| AJR-M | `mature_rating` (posi-data `schema/rating.schema.json`) for Mature journals | `rate-mature.mjs` |
| review | a pull request on posi-data, branch `ajr-rerate/<YYYY-MM>` | |

Nothing reaches posi-data without that pull request being merged. The
workflow needs the `POSI_DATA_TOKEN` secret (push and pull requests on
posi-data); a failed run opens an issue here. `skip_crawl` re-rates from the
stored evidence.

AJR-M takes PNCI and the ranking category from the Citation Ranking edition,
PCI / PCI-5 from the PCI audit, yearly output from `evidence/output/`, and
everything else from the same evidence as AJR-E; how AJR-E's evidence items
map onto AJR-M's is in posi-data
[AJR-M-1.0-SPEC.md](https://github.com/WENSHAO521/posi-data/blob/master/AJR-M-1.0-SPEC.md)
§ 11. The Core Collection has no Mature journal before December 2029.

## Modules

| Area | Modules |
|---|---|
| Evaluation rules | `evaluation.mjs`, `citation-ranking.mjs`, `citation-ranking-check.mjs` |
| Citation indicators | `pnci.mjs` (PNCI-1.0), `pci.mjs` (PCI / PCI-5), `pcs.mjs` + `pcs-resolver.mjs` (PCS-1.0) |
| Lifecycle ratings | `lifecycle.mjs`, `first-publication-date.mjs`, `ajr-early-stage.mjs` (AJR-E-1.1), `ajr-mature.mjs` (AJR-M-1.0), `ajr-e-rerate.mjs`, `ajr-m-rerate.mjs`, `shared-dimensions.mjs`, `evidence-coverage.mjs` |
| Admission | `pqf.mjs` (evidence pre-screen; the public status is `getPQFStatus`) |
| Subjects | `psc-classify.mjs` (PSC-CROSSWALK), `cohort.mjs` |
| Integrity and diagnostics | `citation-integrity.mjs`, `diagnostics.mjs` (MQS / IRS / CVI), `international-reach.mjs`: descriptive, never blended into a score |
| Data acquisition | `works-fetch.mjs`, `works-resolver.mjs`, `evidence-*.mjs`, `output-history.mjs`, `crossref-document-type.mjs`, `openalex-document-type.mjs` |
| Global index | `global-index.mjs`, `sharding.mjs`, `scripts/global/` |
| Identity | `migration/` (normalize, dedupe, mint, supersession), `showjcr/` (bibliographic identity cross-check only) |
| Releases | `release.mjs` (PJR manifests) |

Deprecated, kept so archived editions stay reproducible: `ranking.mjs`,
`quartile-tracks.mjs` (`rankLifecycleTrack` for E-Q / M-Q,
`rankCitationTrack` for the PCI Citation Q) and `pcs-quartile.mjs` as a
ranking (PCS-Q). No pipeline publishes their quartiles.

## Running

```bash
npm install
npm test                                   # node --test, every module

# Citation Ranking edition from a PCS ETL output directory
node scripts/run-citation-ranking.mjs --pcs-dir work/pcs --corpus work/global-corpus.json \
  --taxonomy ../posi-data/taxonomy/psc/v1.0.json --out work/citation-ranking

# AJR-M for the Mature journals of a corpus (writes mature_rating)
node scripts/run-output-history-etl.mjs --mature-only \
  --corpus ../posi-data/corpus/global-benchmark.json --out work/output
node scripts/rate-mature.mjs --corpus ../posi-data/corpus/global-benchmark.json \
  --evidence-journals ../posi-data/evidence/journals --evidence-works ../posi-data/evidence/works \
  --evidence-output work/output/journals \
  --citation-ranking ../posi-data/rankings/citation/citation-ranking-2026.json.gz \
  --pci ../posi-data/audits/pjr-seed-corpus/pjr-seed-corpus-global993-2026/pci \
  --out-corpus work/global-benchmark.rated.json --out-report work/rate-mature-report

# Validate a posi-data checkout against its schemas
node scripts/validate-against-schema.mjs ../posi-data
```

## Principles

- Scores, ranks and quartiles are computed, never set by hand; only evidence
  can be corrected.
- A missing value narrows what is reported; it is never counted as zero.
- External sources are read by ETL steps before scoring; no score reads live
  state.
- JCR impact factors and CAS partitions are never imported; the ShowJCR
  cross-check uses titles and ISSNs only.

## Related repositories

- [posi-data](https://github.com/WENSHAO521/posi-data): canonical data and specifications
- [posi-data-delivery](https://github.com/WENSHAO521/posi-data-delivery): public data layer
- [Panorama-Open-Scholarly-Index](https://github.com/WENSHAO521/Panorama-Open-Scholarly-Index): the website

## License

[MIT](./LICENSE) for the code. Data is licensed separately; see posi-data's
LICENSE-DATA.
