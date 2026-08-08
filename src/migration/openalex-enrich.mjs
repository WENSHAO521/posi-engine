/**
 * OpenAlex enrichment — identity-layer enrichment only (id/issn_l/issn/type),
 * deliberately NOT citation-impact fields. Keeps identity and metrics apart,
 * same as PCI/PNCI staying separate from PQF elsewhere in this project.
 *
 * Uses singleton "get a single source by ISSN" lookups
 * (GET /sources/issn:{issn}), not search/filter — this is the free-tier-
 * unlimited endpoint per OpenAlex's docs, and it's the right tool here since
 * every query is keyed on a specific, already-known ISSN, not a fuzzy match.
 */

const OPENALEX_BASE = 'https://api.openalex.org'
const SELECT_FIELDS = ['id', 'issn_l', 'issn', 'display_name', 'type', 'host_organization_name', 'homepage_url', 'is_oa', 'is_in_doaj', 'works_count']

/**
 * @param {string} issn - already-normalized XXXX-XXXX ISSN
 * @param {{ apiKey?: string, fetchImpl?: Function, timeoutMs?: number, mailto?: string }} opts
 * @returns {Promise<{ status: number | null, source: object | null, error: string | null }>}
 */
export async function fetchOpenAlexSourceByIssn(issn, opts = {}) {
  const { apiKey, fetchImpl = fetch, timeoutMs = 10000, mailto = 'posi@panoramagroup.org' } = opts
  const params = new URLSearchParams({ select: SELECT_FIELDS.join(','), mailto })
  if (apiKey) params.set('api_key', apiKey)
  const url = `${OPENALEX_BASE}/sources/issn:${encodeURIComponent(issn)}?${params.toString()}`

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 404) return { status: 404, source: null, error: null }
    if (!res.ok) return { status: res.status, source: null, error: `HTTP ${res.status}` }
    const data = await res.json()
    return { status: 200, source: normalizeSource(data), error: null }
  } catch (err) {
    return { status: null, source: null, error: err?.message ?? String(err) }
  }
}

function normalizeSource(raw) {
  return {
    id: raw.id ? String(raw.id).replace('https://openalex.org/', '') : null,
    issn_l: raw.issn_l ?? null,
    issn: Array.isArray(raw.issn) ? raw.issn : [],
    display_name: raw.display_name ?? null,
    type: raw.type ?? null,
    host_organization_name: raw.host_organization_name ?? null,
    homepage_url: raw.homepage_url ?? null,
    is_oa: raw.is_oa ?? null,
    is_in_doaj: raw.is_in_doaj ?? null,
    works_count: raw.works_count ?? null,
  }
}

/**
 * Combines per-ISSN lookup results for one candidate entity into a single
 * enrichment verdict. Never merges/mutates the candidate — classification
 * only; actual entity merging (if any) is a separate, later, human-reviewed
 * step. "Conflict beats match": any two DIFFERENT resolved OpenAlex source
 * ids for the same candidate is multiple_sources, full stop, even though
 * OpenAlex itself is not exempt from its own metadata errors.
 *
 * @param {string[]} candidateIssnSet
 * @param {Map<string, {status:number|null, source:object|null, error:string|null}>} issnLookupResults
 * @returns {{ status: string, sources: object[], matched_issns: string[] }}
 */
export function classifyEnrichment(candidateIssnSet, issnLookupResults) {
  const lookups = candidateIssnSet.map(issn => ({ issn, result: issnLookupResults.get(issn) }))

  const erroredLookups = lookups.filter(l => l.result && l.result.status !== 200 && l.result.status !== 404)
  if (erroredLookups.length > 0) {
    return { status: 'review_required', sources: [], matched_issns: [] }
  }

  const found = lookups.filter(l => l.result && l.result.status === 200 && l.result.source)
  if (found.length === 0) {
    return { status: 'not_found', sources: [], matched_issns: [] }
  }

  const uniqueSourceIds = [...new Set(found.map(f => f.result.source.id))]
  if (uniqueSourceIds.length > 1) {
    const sources = uniqueSourceIds.map(id => found.find(f => f.result.source.id === id).result.source)
    return { status: 'multiple_sources', sources, matched_issns: found.map(f => f.issn) }
  }

  const source = found[0].result.source
  if (source.type && source.type !== 'journal') {
    return { status: 'source_type_conflict', sources: [source], matched_issns: found.map(f => f.issn) }
  }

  const status = found.length < candidateIssnSet.length ? 'partial_match' : 'verified'
  return { status, sources: [source], matched_issns: found.map(f => f.issn) }
}
