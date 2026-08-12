# posi-engine

The calculation engine behind **POSI (Panorama Open Scholarly Index)**:
PSC subject classification, lifecycle-based AJR-E/AJR-M journal ratings,
PCI/PCI-5/PNCI citation-impact metrics, category rankings (E-Q/M-Q/Citation Q),
Evidence Coverage crawling, and the identity/registry pipeline that resolves
and mints every journal's permanent `POSI-J-######` id. Reads from and writes
back to [posi-data](https://github.com/WENSHAO521/posi-data), which is the
canonical data store — this repo has no database of its own.

> **Status: implementing "POSI Journal Evaluation & Ranking Framework
> 1.0"** (2026-08) — see [posi-data/CHANGELOG.md](https://github.com/WENSHAO521/posi-data/blob/master/CHANGELOG.md)
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
> **OpenAlex `/works` filtered-list endpoint (2026-08 update):** an
> earlier pass hit `429 {"error":"Rate limit exceeded",
> "dailyRemainingUsd":0}` on this endpoint, suggesting a move to paid-only
> access. Re-verified 2026-08-12: a direct filtered `/works` request
> (`primary_location.source.id:...,type:article,publication_year:...`)
> now returns a clean `200`, unmetered. Whether the earlier failure was a
> temporary budget exhaustion or a policy change since reverted isn't
> confirmed either way — don't assume either direction without checking
> again at the time you rely on it. The free `/sources/{id}` singleton
> lookup this project's identity/PSC/citation enrichment relies on has
> been unaffected throughout.
>
> **2026-08-12 — Elsevier + Frontiers Global Benchmark expansion, identity
> infrastructure hardening, provisional Citation Q.** Global Benchmark grew
> 1000 → 4,289 via two bulk publisher-catalog ingestions (`jnlactive.csv`,
> Frontiers' title list — `scripts/ingest-jnlactive-elsevier-2026.mjs` /
> `scripts/ingest-frontiers-2026.mjs`, sharing `src/migration/bulk-ingest-
> helpers.mjs`). A second-round review found real identity-integrity gaps
> in the first pass (hard-conflict pairs flagged but not actually gated
> from independent minting; superseded records silently orphaning their
> old permanent id) — fixed with `src/migration/supersession.mjs`
> (validated invariants + real resolver follow-through: an old ISSN now
> resolves straight to its surviving `POSI-J-######` id, not the retired
> one) and `registry/excluded-identities.csv` for zero-evidence records.
> `scripts/verify-benchmark-counts.mjs` gives every migration a
> reconciliation check against a committed `expected-count.json` fixture.
> `scripts/compute-benchmark-citation-q-2026.mjs` then computed a
> *provisional* Citation Q (PSC classification + a conservative lifecycle
> check + OpenAlex's own 2yr-mean-citedness, explicitly not a full
> evidence-based AJR-M score) for the 3,296 newly-ingested journals. Full
> writeups: `posi-data`'s `audits/migrations/elsevier-jnlactive-
> expansion-2026/`, `frontiers-expansion-2026/`, and
> `benchmark-citation-q-2026/`.

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
| `src/showjcr/csv.mjs` | **Implemented + tested** | RFC4180-correct CSV parsing (quoted fields, embedded commas/newlines, doubled-quote escapes) — the shared parser every script that reads a source CSV must use, never a hand-rolled `split(',')` |
| `src/migration/normalize.mjs` / `dedupe.mjs` / `identity.mjs` / `mint.mjs` | **Implemented + tested** | Identity resolution pipeline — normalize a raw source record, union-find dedupe via the "conflict beats match" rule (ISSN > OpenAlex Source ID > title/publisher, never auto-merged), resolve-or-mint against `registry/journal-id-map.csv` |
| `src/migration/supersession.mjs` | **Implemented + tested** | `registry/superseded-ids.csv` invariant validation (no cycles/chains/duplicates, every target exists) + real resolver follow-through — an old, retired identity value resolves straight to its surviving `POSI-J-######` id |
| `src/migration/bulk-ingest-helpers.mjs` | **Implemented + tested** | Shared helpers for publisher-catalog bulk-ingestion scripts — both-ISSN existing-record detection, positive-integer concurrency validation, transient-vs-permanent OpenAlex error partitioning, known-bad-identity exclusion |
| `src/evidence-fetch.mjs` / `evidence-page-discovery.mjs` / `evidence-resolver.mjs` / `evidence-publisher-registry.mjs` / `evidence-coverage.mjs` | **Implemented + tested** (EC-1.0) | Evidence ETL v1 — site-crawl fetch with a 10-value status taxonomy, criterion-aware page discovery, publisher-wide policy inheritance, Evidence Coverage % / eligibility gate. Real crawl at Core Collection scale only (31 journals) — most major-publisher platforms block ~73% of requests, see `posi-data`'s `audits/evidence-etl/evidence-etl-v1-core30-2026/` |

## QA / diagnostic scripts

`scripts/cross-check-showjcr-identity.mjs` cross-checks POSI's own
OpenAlex-derived journal identity data against
[hitfyd/ShowJCR](https://github.com/hitfyd/ShowJCR), a Chinese academic
tool that bundles several journal/conference reference CSVs (JCR, the CAS
Journal Partition Table 中科院分区表, a CCF recommended-journal directory,
and an international early-warning list). It flags journals where POSI's
stored title or ISSN disagrees with ShowJCR's, and notes journals in
ShowJCR's lists that aren't in POSI's corpus yet — a report for a human to
review, never an auto-correction.

**Only plain bibliographic identity — journal name, ISSN, EISSN — is ever
pulled from the JCR / CAS-partition / rising-star families.** JCR impact
factors and quartiles are Clarivate's own paid analysis product; CAS
partition tiers are a licensed CAS product. POSI does not import, store,
or display those values anywhere, regardless of what ShowJCR's own
GPL-3.0 license covers for its code — see the script's header comment and
`src/showjcr/extract.mjs` for the full reasoning and the exact
column allow-list per source file. (CCF's own recommendation tier and the
early-warning list's reason field are kept in full — that's each list's
own open IP, not Clarivate's or CAS's.) No ShowJCR CSV is ever committed
into this repo; everything is fetched fresh at request time.

Run it with `node scripts/cross-check-showjcr-identity.mjs --out <dir>` —
see the script header for the full usage and CLI flags.

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
