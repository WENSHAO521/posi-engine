# posi-engine

The calculation engine behind **POSI (Panorama Open Scholarly Index)**:
PSC classification, PCI/PCI-5/PNCI citation-impact metrics, and category
rankings (percentile, quartile). Reads from and writes back to
[posi-data](https://github.com/WENSHAO521/posi-data), which is the canonical
data store — this repo has no database of its own.

> **Status: scaffold.** The ranking calculator (`src/ranking.mjs`) is fully
> implemented against `PJR-SPEC.md § 8` and covered by tests. The PSC
> classifier and PCI calculator are stubs pending the first data migration
> into posi-data (see that repo's README status note) — there's no journal
> corpus to classify or citation data to score yet.

## What this is

Given `posi-data`'s journal/work/citation records as input, `posi-engine`
produces the `metrics/` and `rankings/` records that `posi-data` publishes,
and assembles them into a tagged **PJR** (POSI Journal Reports) release. See
[posi-data/PJR-SPEC.md](https://github.com/WENSHAO521/posi-data/blob/main/PJR-SPEC.md)
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
| `src/pci.mjs` | Stub | PJR-SPEC.md § 5–6 — citable-items filtering, PCI/PCI-5/PNCI formulas |
| `src/psc-classify.mjs` | Stub | PJR-SPEC.md § 10 — topic-distribution-based category suggestion (ML-suggested, human-confirmed) |
| `src/citation-integrity.mjs` | Stub | PJR-SPEC.md § 9 — self-citation rate, citation stacking, clustering, spike detection |
| `src/release.mjs` | Stub | PJR-SPEC.md § 1–3 — manifest generation, asset packaging, GitHub Release |

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
