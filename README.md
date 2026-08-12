# posi-engine

The calculation engine behind **POSI (Panorama Open Scholarly Index)**:
PSC classification, PCI/PCI-5/PNCI citation-impact metrics, and category
rankings (percentile, quartile). Reads from and writes back to
[posi-data](https://github.com/WENSHAO521/posi-data), which is the canonical
data store — this repo has no database of its own.

> **Status: scaffold.** `src/ranking.mjs` (PJR-SPEC.md § 8) and the core of
> `src/pci.mjs` (§ 5–6: `isCitable`, `calculatePci`, `calculatePnci`) are
> implemented and covered by tests. PCI-5, the category-average aggregation
> `calculatePnci`'s baseline depends on, PSC classification, citation
> integrity, and release assembly are stubs — all four need real posi-data
> journal/work/citation records to build and test against, and none exist
> yet (see that repo's README status note).

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
| `src/pci.mjs` | **Core implemented + tested**; PCI-5 and PNCI's category baseline pending | PJR-SPEC.md § 5–6 — citable-items filtering, PCI/PNCI formulas |
| `src/psc-classify.mjs` | Stub | PJR-SPEC.md § 10 — topic-distribution-based category suggestion (ML-suggested, human-confirmed) |
| `src/citation-integrity.mjs` | Stub | PJR-SPEC.md § 9 — self-citation rate, citation stacking, clustering, spike detection |
| `src/release.mjs` | Stub | PJR-SPEC.md § 1–3 — manifest generation, asset packaging, GitHub Release |

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
