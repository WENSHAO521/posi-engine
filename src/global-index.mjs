/**
 * GLOBAL-INDEX-1.0 (posi-data/GLOBAL-INDEX-1.0-SPEC.md) — pure functions for
 * building the global journal corpus from harvested OpenAlex sources and
 * Crossref journals. No I/O.
 *
 * Identity rules (spec § 2):
 *   - merge across sources on ISSN only, never on title
 *   - a journal with a curated record keeps its POSI-J id
 *   - otherwise it is keyed `ISSNL-<issn-l>` (OpenAlex ISSN-L, else the
 *     first Crossref ISSN); POSI-J ids are never minted here
 */
import { classifyPsc } from './psc-classify.mjs'

export const GLOBAL_INDEX_METHODOLOGY_VERSION = 'GLOBAL-INDEX-1.0'

/** Normalise an ISSN to NNNN-NNNC upper-case, or null. */
export function normIssn(v) {
  if (!v) return null
  const s = String(v).trim().toUpperCase().replace(/[^0-9X]/g, '')
  return /^\d{7}[\dX]$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null
}

/** Reduce an OpenAlex source record to the fields the corpus keeps, with a PSC classification. */
export function fromOpenAlexSource(src) {
  const issns = [...new Set([src.issn_l, ...(src.issn ?? [])].map(normIssn).filter(Boolean))]
  const { psc_category, psc_confidence } = classifyPsc(src.topics ?? [], src.works_count ?? 0)
  return {
    openalex_source_id: String(src.id ?? '').replace('https://openalex.org/', '') || null,
    title: src.display_name ?? null,
    publisher: src.host_organization_name ?? null,
    issn_l: normIssn(src.issn_l),
    issns,
    country: src.country_code ?? null,
    open_access: !!src.is_oa,
    in_doaj: !!src.is_in_doaj,
    apc_usd: src.apc_usd ?? null,
    works_count: src.works_count ?? 0,
    psc_category,
    psc_confidence,
  }
}

/** Reduce a Crossref /journals item. */
export function fromCrossrefJournal(item) {
  const issns = [...new Set([...(item.ISSN ?? []), ...(item['issn-type'] ?? []).map(x => x.value)].map(normIssn).filter(Boolean))]
  return {
    title: item.title ?? null,
    publisher: item.publisher ?? null,
    issns,
    crossref_total_dois: item.counts?.['total-dois'] ?? null,
    crossref_current_dois: item.counts?.['current-dois'] ?? null,
  }
}

/**
 * Merge harvested records into one corpus.
 * @param {ReturnType<typeof fromOpenAlexSource>[]} openalex
 * @param {ReturnType<typeof fromCrossrefJournal>[]} crossref
 * @param {{ posi_id: string, issns: string[] }[]} curated - existing curated records (POSI-J ids)
 * @returns {object[]} corpus records shaped for run-pcs-etl.mjs (posi_id, issn_online, issn_print, title, ...)
 */
export function buildGlobalCorpus(openalex, crossref, curated = []) {
  const curatedByIssn = new Map()
  for (const c of curated) for (const i of c.issns.map(normIssn).filter(Boolean)) curatedByIssn.set(i, c.posi_id)

  const records = []
  const byIssn = new Map()
  const attach = (rec) => { for (const i of rec.issns) if (!byIssn.has(i)) byIssn.set(i, rec) }

  for (const oa of openalex) {
    if (!oa.issns.length) continue
    const rec = { ...oa, sources: ['openalex'], crossref_total_dois: null }
    records.push(rec)
    attach(rec)
  }
  for (const cr of crossref) {
    if (!cr.issns.length) continue
    const hit = cr.issns.map(i => byIssn.get(i)).find(Boolean)
    if (hit) {
      hit.sources = [...new Set([...hit.sources, 'crossref'])]
      hit.crossref_total_dois = cr.crossref_total_dois
      for (const i of cr.issns) if (!hit.issns.includes(i)) hit.issns.push(i)
      attach(hit)
      continue
    }
    const rec = {
      openalex_source_id: null, title: cr.title, publisher: cr.publisher, issn_l: null, issns: cr.issns,
      country: null, open_access: null, in_doaj: null, apc_usd: null, works_count: null,
      psc_category: null, psc_confidence: 'unclassified',
      sources: ['crossref'], crossref_total_dois: cr.crossref_total_dois,
    }
    records.push(rec)
    attach(rec)
  }

  const seen = new Set()
  const out = []
  for (const r of records) {
    const curatedId = r.issns.map(i => curatedByIssn.get(i)).find(Boolean) ?? null
    const key = curatedId ?? `ISSNL-${r.issn_l ?? r.issns[0]}`
    if (seen.has(key)) continue // two harvested records resolving to one curated journal
    seen.add(key)
    out.push({
      posi_id: key,
      curated: !!curatedId,
      title: r.title,
      publisher: r.publisher,
      issn_online: r.issns[0] ?? null,
      issn_print: r.issns[1] ?? null,
      issns: r.issns,
      issn_l: r.issn_l,
      openalex_source_id: r.openalex_source_id,
      country: r.country,
      open_access: r.open_access,
      in_doaj: r.in_doaj,
      apc_usd: r.apc_usd,
      works_count: r.works_count,
      crossref_total_dois: r.crossref_total_dois,
      psc_category: r.psc_category,
      psc_confidence: r.psc_confidence,
      sources: r.sources,
      methodology_version: GLOBAL_INDEX_METHODOLOGY_VERSION,
    })
  }
  return out.sort((a, b) => a.posi_id.localeCompare(b.posi_id))
}
