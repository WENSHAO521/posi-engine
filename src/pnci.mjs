/**
 * PNCI-1.0 — POSI Normalized Citation Indicator (posi-data/PNCI-1.0-SPEC.md).
 * The metric behind the official POSI Citation Ranking.
 *
 *   PNCI_j = (1 / n_j) × Σ_i C_i / E(field_i, year_i, type_i)
 *
 * C_i is the citation count of eligible item i of journal j, E the mean
 * citation count of every eligible item of the same PSC field, publication
 * year and document type (the expected-citation baseline), n_j the number of
 * the journal's eligible items. PNCI 1.00 is the average of the comparison
 * group; 2.00 twice the average.
 *
 * Article-level and exact: a journal is carried as "cells", one per
 * (publication year, document type) with a histogram of its items' citation
 * counts, which is all the formula needs. When a (field, year, type) group is
 * too small or has no citations at all, the item is normalized against its
 * (field, year) group instead; the journal records that it used the fallback.
 *
 * Pure functions, no I/O. Replaces the journal-level PCI ÷ category-baseline
 * ratio of PJR-SPEC.md § 6 (pci.mjs calculatePnci(), kept for the PJR
 * archive only).
 */

export const PNCI_MODEL_VERSION = 'PNCI-1.0'

/** A (field, year, type) group needs this many items to serve as a baseline on its own. */
export const MIN_BASELINE_ITEMS = 50

/**
 * Builds the expected-citation baselines from every baseline journal.
 * @param {{ field: string, cells: { y: number, t: string, h: [number, number][] }[] }[]} journals
 *   h is a citation histogram: [citations, number of items with that count].
 * @returns {{ fyt: Map<string, Group>, fy: Map<string, Group> }}
 */
export function buildBaselines(journals) {
  const fyt = new Map()
  const fy = new Map()
  const add = (map, key, h) => {
    let g = map.get(key)
    if (!g) { g = { n: 0, c: 0, hist: new Map() }; map.set(key, g) }
    for (const [cites, freq] of h) {
      g.n += freq
      g.c += cites * freq
      g.hist.set(cites, (g.hist.get(cites) ?? 0) + freq)
    }
  }
  for (const j of journals) {
    if (!j.field) continue
    for (const cell of j.cells ?? []) {
      add(fyt, `${j.field}|${cell.y}|${cell.t}`, cell.h)
      add(fy, `${j.field}|${cell.y}`, cell.h)
    }
  }
  for (const g of [...fyt.values(), ...fy.values()]) {
    g.mean = g.n > 0 ? g.c / g.n : 0
    g.p90 = percentileOfHistogram(g.hist, 0.9)
    delete g.hist
  }
  return { fyt, fy }
}

/**
 * The baseline group an item of (field, year, type) is normalized against.
 * @returns {{ group: object, level: 'field_year_type'|'field_year' } | null}
 */
export function baselineFor(baselines, field, year, type) {
  const g = baselines.fyt.get(`${field}|${year}|${type}`)
  if (g && g.n >= MIN_BASELINE_ITEMS && g.mean > 0) return { group: g, level: 'field_year_type' }
  const f = baselines.fy.get(`${field}|${year}`)
  if (f && f.mean > 0) return { group: f, level: 'field_year' }
  return null
}

/**
 * PNCI for one journal.
 * @param {{ field: string|null, cells: { y: number, t: string, h: [number, number][] }[] }} journal
 * @param {ReturnType<typeof buildBaselines>} baselines
 * @returns {{
 *   pnci: number|null, pnci_model_version: string, normalization: string|null,
 *   eligible_items: number, normalized_items: number, items_without_baseline: number,
 *   publication_years: number[], median_normalized_citation: number|null, top10_share: number|null,
 *   total_citations: number,
 * }}
 */
export function calculatePNCI(journal, baselines) {
  const cells = journal.cells ?? []
  let eligible = 0
  let totalCitations = 0
  let n = 0
  let sum = 0
  let unbaselined = 0
  let top10 = 0
  let usedFallback = false
  const years = new Set()
  const normalized = [] // [value, freq]
  for (const cell of cells) {
    const cellN = cell.h.reduce((s, [, f]) => s + f, 0)
    if (!cellN) continue
    eligible += cellN
    years.add(cell.y)
    totalCitations += cell.h.reduce((s, [c, f]) => s + c * f, 0)
    const b = journal.field ? baselineFor(baselines, journal.field, cell.y, cell.t) : null
    if (!b) { unbaselined += cellN; continue }
    if (b.level === 'field_year') usedFallback = true
    for (const [cites, freq] of cell.h) {
      const v = cites / b.group.mean
      sum += v * freq
      n += freq
      normalized.push([v, freq])
      if (b.group.p90 > 0 && cites >= b.group.p90) top10 += freq
    }
  }
  return {
    pnci: n > 0 ? sum / n : null,
    pnci_model_version: PNCI_MODEL_VERSION,
    normalization: n > 0 ? (usedFallback ? 'field_year_type+field_year_fallback' : 'field_year_type') : null,
    eligible_items: eligible,
    normalized_items: n,
    items_without_baseline: unbaselined,
    publication_years: [...years].sort((a, b) => a - b),
    median_normalized_citation: n > 0 ? weightedMedian(normalized) : null,
    top10_share: n > 0 ? top10 / n : null,
    total_citations: totalCitations,
  }
}

/**
 * Items (Crossref-normalized works) -> cells. Only citable items count
 * (the caller passes pci.mjs isCitable()-filtered works); an absent
 * citation count is counted as 0, as in PCS-1.0 § 7.
 * @param {{ published_year: number|null, document_type: string|null, is_referenced_by_count: number|null }[]} items
 */
export function cellsFromItems(items) {
  const byKey = new Map()
  for (const it of items) {
    if (it.published_year == null || !it.document_type) continue
    const key = `${it.published_year}|${it.document_type}`
    if (!byKey.has(key)) byKey.set(key, { y: it.published_year, t: it.document_type, hist: new Map() })
    const c = it.is_referenced_by_count ?? 0
    const hist = byKey.get(key).hist
    hist.set(c, (hist.get(c) ?? 0) + 1)
  }
  return [...byKey.values()]
    .sort((a, b) => a.y - b.y || a.t.localeCompare(b.t))
    .map(({ y, t, hist }) => ({ y, t, h: [...hist.entries()].sort((a, b) => a[0] - b[0]) }))
}

function percentileOfHistogram(hist, q) {
  const entries = [...hist.entries()].sort((a, b) => a[0] - b[0])
  const total = entries.reduce((s, [, f]) => s + f, 0)
  if (!total) return 0
  let cum = 0
  for (const [v, f] of entries) {
    cum += f
    if (cum / total >= q) return v
  }
  return entries[entries.length - 1][0]
}

function weightedMedian(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  const total = sorted.reduce((s, [, f]) => s + f, 0)
  const lo = Math.floor((total - 1) / 2)
  const hi = Math.floor(total / 2)
  let seen = 0
  let a = null
  let b = null
  for (const [v, f] of sorted) {
    if (a === null && lo < seen + f) a = v
    if (b === null && hi < seen + f) { b = v; break }
    seen += f
  }
  return (a + b) / 2
}
