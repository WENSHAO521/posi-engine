# posi-engine

The calculation engine behind **POSI (Panorama Open Scholarly Index)**:
PSC classification, PCI/PCI-5/PNCI citation-impact metrics, and category
rankings (percentile, quartile). Reads from and writes back to
[posi-data](https://github.com/WENSHAO521/posi-data), which is the canonical
data store — this repo has no database of its own.

> **Status: implementing "POSI Journal Evaluation & Ranking Framework
> 1.0"** (2026-08) — see [posi-data/CHANGELOG.md](https://github.com/WENSHAO521/posi-data/blob/pjr-seed-corpus-1000/CHANGELOG.md)
> for the full list of what changed and why. The original five pipeline
> modules (`ranking.mjs`, `pci.mjs`, `psc-classify.mjs`,
> `citation-integrity.mjs`, `release.mjs`) remain implemented and tested;
> what's new in this pass:
> - `lifecycle.mjs` — fixed to exact date-boundary arithmetic (LIFECYCLE-1.1)
> - `first-publication-date.mjs` — source-priority resolution (new)
> - `psc-classify.mjs` — 4-state confidence (`high`/`medium`/`low`/`unclassified`, PSC-CROSSWALK-0.2)
> - `cohort.mjs` — shared peer-cohort builder, the confidence-gate bug fix (new)
> - `evidence-coverage.mjs` — Evidence Coverage / eligibility gate (new)
> - `shared-dimensions.mjs` — Transparency dimension, shared by AJR-E & AJR-M (new)
> - `ajr-early-stage.mjs` — rewritten to AJR-E 1.1 (4 documented bug fixes)
> - `ajr-mature.mjs` — AJR-M 1.0, did not exist before (new)
> - `quartile-tracks.mjs` — E-Q / M-Q / Citation Q, one shared ranking core (new)
> - `pqf.mjs` — admission-only 4-value output contract (new)
> - `diagnostics.mjs` — MQS / IRS / CVI, verified never blended into a score (new)
> - `international-reach.mjs` — descriptive-only, verified never blended into a score (new)
>
> What's still genuinely untested at scale is real citation-EDGE data
> (journal-to-journal citing relationships) — `selfCitationRate`,
> `citationStacking`, `publisherCitationCluster`, and `citationCartel` are
> implemented and unit tested, but the seed-corpus pipeline run (see
> `posi-data`'s `pjr-seed-corpus-1000` branch) could only exercise
> `citationConcentration` and `suddenCitationSpike` against real data —
> building a real citation-edge dataset (resolving every citing work back
> to its own journal) is a separate, materially more expensive ETL pass
> than what per-journal OpenAlex enrichment provides. AJR-E/AJR-M also
> remain untested against real site-crawl evidence (no evidence-resolver
> ETL exists yet — this pass built the scoring/normalization layer these
> future evidence records will feed). See the PR description for the full
> list of what's real vs. synthetic-only so far.
>
> **Known external blocker (2026-08):** the seed-corpus pipeline
> completed identity resolution for all 1000 benchmark journals (real
> `POSI-J-######` ids minted, see `posi-data`'s
> `journals/discovered/global-benchmark-seed-2025.jsonl`), but PCI/PCI-5/
> PNCI could not be computed — **OpenAlex's `/works` filtered-list
> endpoint now requires paid credits**, confirmed via a direct request
> returning `429 {"error":"Rate limit exceeded", "dailyRemainingUsd":0}`.
> The free `/sources/{id}` singleton lookup this project's identity/PSC
> enrichment relies on is unaffected. This is a real, structural change to
> OpenAlex's API pricing that affects every future PJR release pipeline
> run, not a bug in this project's code — see `posi-data`'s
> `audits/migrations/benchmark-corpus-seed/README.md` for the full
> writeup and reproduction steps once paid access is available.

## What this is

Given `posi-data`'s journal/work/citation records as input, `posi-engine`
produces the `metrics/` and `rankings/` records that `posi-data` publishes,
and assembles them into a tagged **PJR** (POSI Journal Reports) release. See
[posi-data/PJR-SPEC.md](https://github.com/WENSHAO521/posi-data/blob/master/PJR-SPEC.md)
for the full methodology every calculation here implements.

```
posi-data (journals, works, citations)
        │
        ▼
  src/psc-classify.mjs   → suggested PSC categories (POSI Subject Editors confirm)
        │
        ▼
  src/pci.mjs            → PCI / PCI-5 / PNCI per journal per metric_year
        │
        ▼
  src/citation-integrity.mjs → self-citation / stacking / cartel flags → suppression
        │
        ▼
  src/ranking.mjs        → rank / mid-rank percentile / quartile per category
        │
        ▼
  src/release.mjs        → manifest.json + PJR GitHub Release
```

## Modules

| Module | Status | Implements |
|---|---|---|
| `src/ranking.mjs` | **Implemented + tested** | PJR-SPEC.md § 8 — mid-rank tie handling, percentile formula, `MIN_CATEGORY_SIZE` gate (Citation Q's engine) |
| `src/pci.mjs` | **Implemented + tested** (PCI, PCI-5, PNCI + category baseline) | PJR-SPEC.md § 5–6 — citable-items filtering, PCI/PCI-5/PNCI formulas |
| `src/psc-classify.mjs` | **Implemented + tested** | PSC-CROSSWALK.md § "PSC-CROSSWALK-0.2" — OpenAlex topic-to-PSC crosswalk, 4-state confidence (`high`/`medium`/`low`/`unclassified`) |
| `src/cohort.mjs` | **Implemented + tested** | Shared E-Q/M-Q peer-cohort builder — confidence gate (only `high`/`verified` rank) + PSC L3/L2/L1 minimum-cohort fallback chain |
| `src/quartile-tracks.mjs` | **Implemented + tested** | E-Q / M-Q / Citation Q — one shared midrank/percentile core, "never a bare Q1" display labeling |
| `src/lifecycle.mjs` | **Implemented + tested** (LIFECYCLE-1.1) | Exact date-boundary lifecycle staging (Observation/Early-Stage/Mature) |
| `src/first-publication-date.mjs` | **Implemented + tested** (FPD-1.0) | Source-priority First Regular Scholarly Publication Date resolution |
| `src/evidence-coverage.mjs` | **Implemented + tested** (EC-1.0) | Evidence Coverage %, dimension-score normalization, Official/Provisional/Not-Rateable eligibility gate |
| `src/shared-dimensions.mjs` | **Implemented + tested** | Transparency & Access Policy — shared verbatim between AJR-E and AJR-M |
| `src/ajr-early-stage.mjs` | **Implemented + tested** (AJR-E-1.1) | posi-data/AJR-E-1.1-SPEC.md — 7-dimension Early-Stage rating, 4 documented bug fixes vs. AJR-E-1.0 |
| `src/ajr-mature.mjs` | **Implemented + tested** (AJR-M-1.0) | posi-data/AJR-M-1.0-SPEC.md — 6-dimension Mature rating (did not exist before); citation-integrity gate never deducts points |
| `src/pqf.mjs` | **Implemented + tested** (PQF-1.0) | Admission-only 4-value output contract (`Eligible`/`Review Required`/`Insufficient Evidence`/`Not Eligible`) |
| `src/diagnostics.mjs` | **Implemented + tested** (DIAG-1.0) | MQS / IRS / CVI — verified structurally excluded from every scoring module |
| `src/international-reach.mjs` | **Implemented + tested** (INTL-1.0) | Descriptive-only reach fields — verified structurally excluded from every scoring module |
| `src/citation-integrity.mjs` | **Implemented + tested** (see status note above re: real citation-edge data) | PJR-SPEC.md § 9 — self-citation rate, citation stacking, concentration, publisher clustering, spike, cartel detection |
| `src/release.mjs` | **Implemented + tested** | PJR-SPEC.md § 1–3 — manifest generation (`buildManifest`, `validateManifest`), asset filename/SHA256SUMS assembly. Does **not** call the GitHub Releases API — publishing stays a separate, human-triggered step. |
| `src/openalex-document-type.mjs` | **Implemented + tested** | Maps OpenAlex work `type` -> PJR-SPEC.md § 5 `document_type`, documenting every type this project has observed and why (see module header) |

## Running the tests

```bash
npm install
npm test
```

## Design principles

Same as [posi-data](https://github.com/WENSHAO521/posi-data)'s: every
formula here is a pure function of its documented inputs, so that
`git checkout <engine_commit>` (pinned in a PJR manifest) plus the
corresponding `posi-data` commit reproduces a published metric exactly.
No calculation in this repo reads live external state at scoring time —
external-source ingestion (Crossref/OpenAlex/OpenCitations/DOAJ/ROR) is a
separate, earlier ETL step that produces the `posi-data` records this engine
consumes.

## License

[MIT](./LICENSE) for the code in this repository. The data it operates on
and produces is licensed separately — see
[posi-data](https://github.com/WENSHAO521/posi-data)'s LICENSE-DATA.
