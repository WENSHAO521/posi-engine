# posi-engine

The calculation engine behind **POSI (Panorama Open Scholarly Index)**:
PSC classification, PCI/PCI-5/PNCI citation-impact metrics, and category
rankings (percentile, quartile). Reads from and writes back to
[posi-data](https://github.com/WENSHAO521/posi-data), which is the canonical
data store — this repo has no database of its own.

> **Status: all five pipeline modules implemented and tested.**
> `src/ranking.mjs` (§ 8), `src/pci.mjs` (§ 5–6, including PCI-5 and the
> `calculateCategoryBaseline` PNCI baseline), `src/psc-classify.mjs`
> (OpenAlex-topic crosswalk, see PSC-CROSSWALK.md), `src/citation-integrity.mjs`
> (§ 9 heuristic checks), and `src/release.mjs` (§ 1–3 manifest assembly) all
> have unit tests against synthetic fixtures. What's still genuinely
> untested at scale is real citation-EDGE data (journal-to-journal citing
> relationships) — `selfCitationRate`, `citationStacking`,
> `publisherCitationCluster`, and `citationCartel` are implemented and unit
> tested, but the seed-corpus pipeline run (see `posi-data`'s
> `pjr-seed-corpus-1000` branch) could only exercise
> `citationConcentration` and `suddenCitationSpike` against real data —
> building a real citation-edge dataset (resolving every citing work back
> to its own journal) is a separate, materially more expensive ETL pass
> than what per-journal OpenAlex enrichment provides. See that branch's PR
> description for the full list of what's real vs. synthetic-only so far.

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
| `src/ranking.mjs` | **Implemented + tested** | PJR-SPEC.md § 8 — mid-rank tie handling, percentile formula, `MIN_CATEGORY_SIZE` gate |
| `src/pci.mjs` | **Implemented + tested** (PCI, PCI-5, PNCI + category baseline) | PJR-SPEC.md § 5–6 — citable-items filtering, PCI/PCI-5/PNCI formulas |
| `src/psc-classify.mjs` | **Implemented + tested** | PSC-CROSSWALK.md — OpenAlex topic-to-PSC crosswalk with concentration + sample-size confidence gates |
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
