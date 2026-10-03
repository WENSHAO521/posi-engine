/**
 * GLOBAL-INDEX-1.0 (posi-data/GLOBAL-INDEX-1.0-SPEC.md) — pure functions for
 * building the global journal corpus from harvested OpenAlex sources and
 * Crossref journals. No I/O.
 *
 * Identity rules (spec § 2):
 *   - merge across sources on ISSN only, never on title
 *   - a journal with a curated record keeps its POSI-J id, and its curated
 *     title (checked against the ISSN Portal) when it has one: registry
 *     titles can lag a rename, so the harvested title is kept in
 *     alternate_titles instead
 *   - otherwise it is keyed `ISSNL-<issn-l>` (OpenAlex ISSN-L, else the
 *     first Crossref ISSN); POSI-J ids are never minted here
 *   - publisher: OpenAlex's host organisation, else the publisher Crossref
 *     records for the journal (the member that registers its DOIs); which
 *     one was used is kept in publisher_source
 *   - an ISSN is required for indexing (as in the major citation databases):
 *     OpenAlex "journals" without one are mostly conference and meeting
 *     collections, and Crossref entries without one have no identifier to
 *     merge on; both are left out
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
    // Top topic fields, kept so every classification can be audited.
    topic_fields: (src.topics ?? []).slice(0, 3).map(t => [t.field?.display_name ?? null, t.subfield?.display_name ?? null, t.count ?? 0]),
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
 * Comparison key for titles: case, punctuation, "&"/"and" and a leading
 * "The" do not make two titles different.
 */
export function titleKey(t) {
  return String(t ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '')
}

/**
 * An alternate title is a string or `{ title, type, lang?, until? }`
 * (posi-data schema/journal.schema.json). Returns its title text.
 */
export function alternateTitleText(a) {
  return typeof a === 'string' ? a : a?.title ?? null
}

/** Distinct alternate titles other than `title`, keeping the first form of each. */
function alternates(title, titles) {
  const seen = new Set([titleKey(title)])
  return titles.filter(a => {
    const k = titleKey(alternateTitleText(a))
    return k && !seen.has(k) && seen.add(k)
  })
}

/**
 * Merge harvested records into one corpus.
 * @param {ReturnType<typeof fromOpenAlexSource>[]} openalex
 * @param {ReturnType<typeof fromCrossrefJournal>[]} crossref
 * @param {{ posi_id: string, issns: string[], title?: string|null, alternate_titles?: (string|object)[]|null }[]} curated - existing curated records (POSI-J ids)
 * @returns {object[]} corpus records shaped for run-pcs-etl.mjs (posi_id, issn_online, issn_print, title, ...).
 *   A curated record whose harvested title differs from its curated title
 *   carries the harvested one as `registry_title` (see titleMismatches).
 */
export function buildGlobalCorpus(openalex, crossref, curated = []) {
  const curatedByIssn = new Map()
  for (const c of curated) for (const i of c.issns.map(normIssn).filter(Boolean)) curatedByIssn.set(i, c)

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
      // OpenAlex has no host organisation for many journals; Crossref's
      // publisher for the same ISSN fills the gap.
      if (!hit.publisher?.trim() && cr.publisher?.trim()) { hit.publisher = cr.publisher.trim(); hit.publisher_source = 'crossref' }
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
    const c = r.issns.map(i => curatedByIssn.get(i)).find(Boolean) ?? null
    const key = c?.posi_id ?? `ISSNL-${r.issn_l ?? r.issns[0]}`
    if (seen.has(key)) continue // two harvested records resolving to one curated journal
    seen.add(key)
    const ordered = r.issn_l ? [r.issn_l, ...r.issns.filter(i => i !== r.issn_l)] : r.issns
    const title = c?.title || r.title
    const alternateTitles = c ? alternates(title, [...(c.alternate_titles ?? []), r.title]) : []
    const registryTitle = c && r.title && titleKey(r.title) !== titleKey(title) ? r.title : null
    out.push({
      posi_id: key,
      curated: !!c,
      title,
      ...(alternateTitles.length ? { alternate_titles: alternateTitles } : {}),
      ...(registryTitle ? { registry_title: registryTitle } : {}),
      publisher: r.publisher?.trim() || null,
      publisher_source: !r.publisher?.trim() ? null : r.publisher_source ?? (r.sources[0] === 'crossref' ? 'crossref' : 'openalex'),
      // The ETL queries issn_online first: put the ISSN-L there, since a
      // journal's secondary ISSNs often have few or no DOIs registered.
      issn_online: ordered[0] ?? null,
      issn_print: ordered[1] ?? null,
      issns: ordered,
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

/**
 * Curated journals whose Crossref/OpenAlex title differs from the curated
 * title and is not yet recorded among its alternate titles: each needs a
 * decision, either record it as an alternate title or have the registry
 * corrected.
 * @param {object[]} corpus - buildGlobalCorpus output
 * @param {{ posi_id: string, alternate_titles?: (string|object)[]|null }[]} curated
 * @returns {{ posi_id: string, title: string, registry_title: string }[]}
 */
export function titleMismatches(corpus, curated) {
  const known = new Map(curated.map(c => [c.posi_id, new Set((c.alternate_titles ?? []).map(a => titleKey(alternateTitleText(a))))]))
  return corpus
    .filter(r => r.registry_title && !known.get(r.posi_id)?.has(titleKey(r.registry_title)))
    .map(r => ({ posi_id: r.posi_id, title: r.title, registry_title: r.registry_title }))
}
