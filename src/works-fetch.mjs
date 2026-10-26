/**
 * Works fetch layer — Article-Sample ETL v1's I/O stage. Fetches per-journal
 * article-level records (title, abstract, reference count, license,
 * authors with ORCID/given/family/affiliation, publication dates) from
 * Crossref's `/journals/{issn}/works` REST API, keyed on a journal's own
 * ISSN. This is the data source `ajr-early-stage.mjs`'s Dimension 5
 * (Scholarly Output Quality Signals) and Dimension 6 (Scholarly Reach &
 * Concentration) scorers require as their `articles` input, and part of
 * what Dimension 3 (Infrastructure) and Dimension 4 (Publishing Stability)
 * need — none of which existed anywhere in posi-data before this module
 * (see posi-data's evidence-etl-v1-core30-2026 audit: that pipeline crawls
 * journal WEBSITES for policy disclosures, dimensions 1/2/7 only; it never
 * fetches article-level bibliographic data at all).
 *
 * Crossref, not OpenAlex, is the primary source here on purpose: Crossref's
 * `author` objects carry split `given`/`family` names (OpenAlex only
 * exposes a combined `display_name`, which `ajr-early-stage.mjs`'s
 * `resolveAuthorIdentity()` explicitly requires split given+family for —
 * see that function's header, the AJR-E-1.1 bug fix around author-identity
 * resolution). Crossref also exposes `references-count`, `license`,
 * `abstract`, and `deposited`/`published` timestamps directly, which is
 * everything `scoreOutputSignals()`/`scoreReachConcentration()`/the
 * Infrastructure and Publishing Stability sub-scorers need. AJR-SPEC.md's
 * own First Regular Scholarly Publication Date resolution priority already
 * ranks Crossref above OpenAlex for the same reason (better structured
 * metadata) — see `first-publication-date.mjs`.
 *
 * Pure I/O + retry/backoff only — no scoring, no normalization into the
 * ajr-early-stage.mjs input contract (see `works-resolver.mjs` for that).
 * Every function accepts an injectable `fetchImpl` so tests never make a
 * real network call, matching `evidence-fetch.mjs` / `openalex-enrich.mjs`'s
 * existing convention in this repo.
 */

const CROSSREF_BASE = 'https://api.crossref.org'
const DEFAULT_MAILTO = 'posi@panorama-sg.com'

/** Fields requested from Crossref's works list route. Deliberately excludes
 * heavy fields this project never uses (full `reference` array contents,
 * `funder`, `assertion`, ...) to keep each page's payload small across a
 * 31-to-1000-journal batch run. `references-count` (Crossref's real field
 * name — NOT `reference-count`, which is a `/works/{doi}` singleton-route
 * field that this list route rejects with a 400) gives the reference-count
 * signal `scoreOutputSignals()` needs without downloading the full
 * reference list. */
export const WORKS_SELECT_FIELDS = [
  'DOI', 'title', 'author', 'abstract', 'references-count', 'license',
  'type', 'published', 'issue', 'volume', 'container-title', 'archive',
  'deposited', 'issued',
]

/** Fields requested for PCS's data-acquisition script (PCS-1.0-SPEC.md
 * § 8) — a much lighter payload than WORKS_SELECT_FIELDS since PCS needs
 * only enough per work to bucket it into the 4-year publication window,
 * normalize its document_type (crossref-document-type.mjs), and read its
 * citation count. `is-referenced-by-count` is Crossref's real field name
 * for its aggregate citation count (verified live) and is the one field
 * WORKS_SELECT_FIELDS never requested — Article-Sample ETL v1 had no use
 * for it, but PCS's entire numerator comes from it. */
export const PCS_SELECT_FIELDS = ['DOI', 'type', 'is-referenced-by-count', 'published', 'issued']

/**
 * @param {number|string|null} outcome - an HTTP status, or 'timeout'/'network_error'
 * @returns {boolean} whether this outcome is worth retrying (transient),
 *   mirroring enrich-openalex.mjs's lookupWithRetry() retry policy: retry
 *   429/5xx/network-level failures, never retry a definitive 2xx/4xx answer.
 */
function isRetryableOutcome(status) {
  return status === 429 || status === null || (typeof status === 'number' && status >= 500)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * One page of a journal's Crossref works, cursor-paginated.
 * @param {string} issn
 * @param {{
 *   cursor?: string, rows?: number, filter?: string, sort?: string, order?: string,
 *   apiKey?: string, mailto?: string, fetchImpl?: Function, timeoutMs?: number, maxAttempts?: number,
 *   selectFields?: string[],
 * }} [opts] - `selectFields` defaults to WORKS_SELECT_FIELDS (Article-Sample
 *   ETL v1's field list); pass PCS_SELECT_FIELDS for PCS's lighter,
 *   is-referenced-by-count-carrying payload instead of adding a second
 *   fetch function.
 * @returns {Promise<{ status: number|null, totalResults: number|null, items: object[], nextCursor: string|null, error: string|null }>}
 */
/**
 * Process-wide Crossref request counters, reported in run-pcs-etl.mjs's
 * summary: how many page requests were made, how many were answered 429,
 * and how long was spent waiting them out. They show whether a run is
 * limited by Crossref's rate limit (and so whether more shards would help).
 */
export const crossrefRequestStats = { requests: 0, rate_limited: 0, rate_limit_wait_ms: 0 }

/** Sorts Crossref refuses to combine with a cursor (HTTP 400
 * `sort-criteria-incompatible-with-cursor`, since 2026-10): a list sorted by
 * one of these is paged with `offset` instead, which Crossref caps at
 * CROSSREF_MAX_OFFSET records. */
export const CURSOR_INCOMPATIBLE_SORTS = new Set(['issued', 'published', 'published-print', 'published-online'])
export const CROSSREF_MAX_OFFSET = 10_000

export async function fetchCrossrefWorksPage(issn, opts = {}) {
  const {
    cursor = '*', offset, rows = 50, filter = 'type:journal-article', sort = 'published', order = 'desc',
    apiKey, mailto = DEFAULT_MAILTO, fetchImpl = fetch, timeoutMs = 15000, maxAttempts = 4,
    selectFields = WORKS_SELECT_FIELDS,
  } = opts

  const params = new URLSearchParams({
    rows: String(rows), filter, sort, order,
    select: selectFields.join(','), mailto,
  })
  // A date sort cannot take a cursor (CURSOR_INCOMPATIBLE_SORTS): page it by offset.
  if (offset != null || CURSOR_INCOMPATIBLE_SORTS.has(sort)) params.set('offset', String(offset ?? 0))
  else params.set('cursor', cursor)
  if (apiKey) params.set('api_key', apiKey)
  const url = `${CROSSREF_BASE}/journals/${encodeURIComponent(issn)}/works?${params.toString()}`

  let lastError = null
  let lastStatus = null
  for (let attempt = 1; attempt <= maxAttempts + 4; attempt++) {
    try {
      crossrefRequestStats.requests++
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      lastStatus = res.status
      if (res.status === 404) return { status: 404, totalResults: 0, items: [], nextCursor: null, error: null }
      if (!res.ok) {
        // Rate limited: wait as long as Crossref asks (Retry-After), or back
        // off exponentially up to a minute, and keep trying longer than for
        // other errors, so a busy period never marks a journal as failed.
        if (res.status === 429 && attempt < maxAttempts + 4) {
          const after = Number(res.headers?.get?.('retry-after'))
          const wait = after > 0 ? after * 1000 : Math.min(60_000, 2 ** attempt * 1000)
          crossrefRequestStats.rate_limited++
          crossrefRequestStats.rate_limit_wait_ms += wait
          await sleep(wait)
          continue
        }
        if (isRetryableOutcome(res.status) && attempt < maxAttempts) { await sleep(2 ** attempt * 500); continue }
        // Crossref says what was wrong with a request in the body of a 4xx
        // (e.g. which select field it rejects); keep it, or a 400 is opaque.
        let detail = ''
        try { detail = (await res.text?.())?.trim().slice(0, 300) ?? '' } catch { /* body unreadable */ }
        return { status: res.status, totalResults: null, items: [], nextCursor: null, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` }
      }
      const data = await res.json()
      const message = data?.message ?? {}
      return {
        status: 200,
        totalResults: message['total-results'] ?? null,
        items: Array.isArray(message.items) ? message.items : [],
        nextCursor: message['next-cursor'] ?? null,
        error: null,
      }
    } catch (err) {
      lastError = err?.message ?? String(err)
      lastStatus = null
      if (attempt < maxAttempts) { await sleep(2 ** attempt * 500); continue }
      break
    }
  }
  return { status: lastStatus, totalResults: null, items: [], nextCursor: null, error: lastError ?? `failed after ${maxAttempts} attempts` }
}

/**
 * Cheap count-only query (`rows=0`) — Crossref returns `total-results`
 * without paginating any items, so callers needing only the real total
 * article count (Dimension 4's output-adequacy denominator) don't have to
 * download and normalize every record just to count them.
 * @param {string} issn
 * @param {Parameters<typeof fetchCrossrefWorksPage>[1]} [opts]
 * @returns {Promise<{ status: number|null, totalResults: number|null, error: string|null }>}
 */
export async function fetchCrossrefTotalResults(issn, opts = {}) {
  const page = await fetchCrossrefWorksPage(issn, { ...opts, rows: 0, offset: 0 })
  return { status: page.status, totalResults: page.totalResults, error: page.error }
}

/** Hard ceiling on how many records one journal's fetch will page through,
 * regardless of `total-results` — a defensive cap so one journal with an
 * unexpectedly huge Crossref-registered backlog can't dominate a batch
 * run's time/request budget. Well above `TARGET_ARTICLE_SAMPLE_SIZE` (30,
 * ajr-early-stage.mjs) so it never actually constrains a normal-sized
 * Early-Stage journal. */
export const MAX_WORKS_FETCHED_PER_JOURNAL = 300

/** PCS's own ceiling (PCS-1.0-SPEC.md § 5: "no 200-item sampling cap" —
 * every eligible work in the 4-year window, full stop). This is NOT a
 * sampling cap the way MAX_WORKS_FETCHED_PER_JOURNAL is one for Article-
 * Sample ETL v1 — it exists only as a defensive backstop against a
 * runaway/looping fetch (e.g. a cursor that somehow never terminates),
 * set far above any real journal's true 4-year output. Verified live
 * against Scientific Reports (ISSN 2045-2322), the single highest-volume
 * journal actually found in this project's Global Benchmark corpus:
 * 126,635 works in the 2022-2025 window (see the PCS ETL audit) — this
 * ceiling is more than 15x that real observed maximum, so it should never
 * actually bind for any journal in scope. If it ever does bind, that is a
 * fetch-loop bug to investigate, not a legitimate truncation. */
export const PCS_MAX_WORKS_PER_JOURNAL = 2_000_000

/**
 * Pages through a journal's full (capped) Crossref works list, most-recent
 * first. Sorted by a date (the default), it pages by offset and stops at
 * CROSSREF_MAX_OFFSET records; any other sort pages by cursor. Returns raw Crossref work objects, unnormalized — see
 * `works-resolver.mjs#normalizeCrossrefWork()` for the ajr-early-stage.mjs
 * input-contract shape.
 * @param {string} issn
 * @param {Parameters<typeof fetchCrossrefWorksPage>[1] & { maxItems?: number }} [opts]
 * @returns {Promise<{ status: number|null, totalResults: number|null, items: object[], error: string|null, pagesFetched: number }>}
 */
export async function fetchAllCrossrefWorks(issn, opts = {}) {
  const { rows = 50, sort = 'published' } = opts
  const byOffset = CURSOR_INCOMPATIBLE_SORTS.has(sort)
  const maxItems = byOffset ? Math.min(opts.maxItems ?? MAX_WORKS_FETCHED_PER_JOURNAL, CROSSREF_MAX_OFFSET) : (opts.maxItems ?? MAX_WORKS_FETCHED_PER_JOURNAL)
  let cursor = '*'
  let items = []
  let totalResults = null
  let pagesFetched = 0
  for (;;) {
    const page = await fetchCrossrefWorksPage(issn, byOffset ? { ...opts, sort, rows, offset: items.length } : { ...opts, sort, rows, cursor })
    pagesFetched++
    if (page.status !== 200) {
      // A 404 legitimately means "no ISSN match" (not an error) -- surfaced
      // via status, with whatever was already collected (nothing, on the
      // first page) returned rather than discarded.
      return { status: page.status, totalResults: page.totalResults, items, error: page.error, pagesFetched }
    }
    totalResults = page.totalResults
    items = items.concat(page.items)
    const exhausted = page.items.length === 0 || items.length >= maxItems
      || (byOffset ? (totalResults != null && items.length >= totalResults) : !page.nextCursor)
    if (exhausted) {
      return { status: 200, totalResults, items: items.slice(0, maxItems), error: null, pagesFetched }
    }
    cursor = page.nextCursor
  }
}

// ---------------------------------------------------------------------
// DataCite fallback
// ---------------------------------------------------------------------

const DATACITE_BASE = 'https://api.datacite.org'
/** DataCite serves page-number results only up to this many records. */
export const DATACITE_MAX_RECORDS = 10_000

/** DataCite resourceTypeGeneral -> the Crossref `type` the resolvers read.
 * Records filed under a journal's ISSN are its contributions: Zenodo-hosted
 * journals commonly type their articles Dataset, Text or Other, so those
 * count as journal articles here (the same rule the site's journal listing
 * uses). Anything unlisted keeps a lower-case form of DataCite's own type,
 * which the resolvers treat as a non-article. */
const DATACITE_TYPE = {
  JournalArticle: 'journal-article', Dataset: 'journal-article', Text: 'journal-article', Other: 'journal-article',
  ConferencePaper: 'proceedings-article', Preprint: 'posted-content', PeerReview: 'peer-review',
  BookChapter: 'book-chapter', Book: 'book', Report: 'report', Dissertation: 'dissertation', Standard: 'standard',
}

function isoToDateParts(iso) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(iso ?? ''))
  if (!m) return undefined
  return { 'date-parts': [[Number(m[1]), ...(m[2] ? [Number(m[2])] : []), ...(m[3] ? [Number(m[3])] : [])]] }
}

/**
 * One DataCite record (`data[].attributes`) in the shape of a Crossref
 * work-list item, so `normalizeCrossrefWork()` and
 * `normalizeCrossrefWorkForPcs()` read it unchanged. Fields DataCite does
 * not have (archive) stay absent, so they score as missing, never as met.
 * `_source: 'datacite'` marks where the record came from.
 * @param {object} a
 */
export function dataciteToCrossrefItem(a) {
  const issued = a.dates?.find(d => d?.dateType === 'Issued')?.date ?? a.published ?? (a.publicationYear ? String(a.publicationYear) : null)
  const general = a.types?.resourceTypeGeneral ?? null
  const abstract = a.descriptions?.find(d => d?.descriptionType === 'Abstract')?.description ?? null
  const container = a.container ?? {}
  const pages = [container.firstPage, container.lastPage].filter(Boolean).join('-')
  return {
    _source: 'datacite',
    DOI: a.doi ?? null,
    title: a.titles?.[0]?.title ? [a.titles[0].title] : [],
    author: (a.creators ?? []).filter(c => c?.nameType !== 'Organizational').map(c => {
      const orcid = c.nameIdentifiers?.find(n => /orcid/i.test(`${n?.nameIdentifierScheme ?? ''} ${n?.nameIdentifier ?? ''}`))?.nameIdentifier
      return {
        given: c.givenName ?? null,
        family: c.familyName ?? (c.givenName ? null : c.name ?? null),
        ...(orcid ? { ORCID: orcid } : {}),
        affiliation: (c.affiliation ?? []).map(x => (typeof x === 'string' ? { name: x } : { name: x?.name })).filter(x => x.name),
      }
    }),
    ...(abstract ? { abstract } : {}),
    'references-count': typeof a.referenceCount === 'number' ? a.referenceCount : 0,
    'is-referenced-by-count': typeof a.citationCount === 'number' ? a.citationCount : 0,
    license: (a.rightsList ?? []).filter(r => r?.rightsUri).map(r => ({ URL: r.rightsUri })),
    type: general ? DATACITE_TYPE[general] ?? general.toLowerCase() : null,
    published: isoToDateParts(issued),
    issued: isoToDateParts(issued),
    deposited: isoToDateParts(a.registered ?? a.created),
    ...(container.volume ? { volume: container.volume } : {}),
    ...(container.issue ? { issue: container.issue } : {}),
    ...(pages ? { page: pages } : {}),
    'container-title': container.title ? [container.title] : [],
  }
}

/** DataCite query for the records that name `issn` as their container or as
 * an IsPartOf related identifier (how Zenodo registers a journal's deposits).
 * Zenodo registers every deposit twice, a concept DOI (HasVersion -> each
 * version) and a version DOI; the concept records are left out so an
 * article counts once. Checked live 2026-10-26: ISSN 2058-5519 has 1,956
 * records, 985 without the concept DOIs. */
export function dataciteIssnQuery(issn, { fromYear, untilYear } = {}) {
  const clauses = [
    `(relatedIdentifiers.relatedIdentifier:"${issn}" OR container.identifier:"${issn}")`,
    'NOT relatedIdentifiers.relationType:HasVersion',
  ]
  if (fromYear || untilYear) clauses.push(`publicationYear:[${fromYear ?? '*'} TO ${untilYear ?? '*'}]`)
  return clauses.join(' AND ')
}

/**
 * Every DataCite record filed under a journal's ISSN, as Crossref-shaped
 * items (`dataciteToCrossrefItem`). Used when Crossref has no works under
 * the journal's ISSNs: journals that register DOIs with DataCite (Zenodo
 * included) are otherwise read as having published nothing. Same return
 * shape as `fetchAllCrossrefWorks()`, with 404 meaning "DataCite has
 * nothing under this ISSN". Newest first by registration, paged by page
 * number (DataCite's cursor paging ignores the sort), which DataCite stops
 * at DATACITE_MAX_RECORDS; `totalResults` still reports the full count, so a
 * capped fetch shows as partial coverage, never as a smaller journal.
 * @param {string} issn
 * @param {{ fromYear?: number, untilYear?: number, maxItems?: number, rows?: number,
 *   fetchImpl?: Function, timeoutMs?: number, maxAttempts?: number }} [opts]
 * @returns {Promise<{ status: number|null, totalResults: number|null, items: object[], error: string|null, pagesFetched: number }>}
 */
export async function fetchAllDataciteWorks(issn, opts = {}) {
  const { fromYear, untilYear, rows = 500, fetchImpl = fetch, timeoutMs = 30000, maxAttempts = 4 } = opts
  const maxItems = Math.min(opts.maxItems ?? MAX_WORKS_FETCHED_PER_JOURNAL, DATACITE_MAX_RECORDS)
  const size = Math.min(rows, 1000, maxItems)
  let items = []
  let totalResults = null
  let pagesFetched = 0
  for (;;) {
    const params = new URLSearchParams({
      query: dataciteIssnQuery(issn, { fromYear, untilYear }),
      'page[size]': String(size), 'page[number]': String(pagesFetched + 1), sort: '-created',
    })
    const url = `${DATACITE_BASE}/dois?${params.toString()}`
    let res = null
    let error = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
        error = null
        if (!isRetryableOutcome(res.status) || attempt === maxAttempts) break
      } catch (err) {
        res = null
        error = err?.message ?? String(err)
        if (attempt === maxAttempts) break
      }
      await sleep(2 ** attempt * 500)
    }
    if (!res || !res.ok) {
      return { status: res?.status ?? null, totalResults, items, error: error ?? `HTTP ${res?.status}`, pagesFetched }
    }
    const data = await res.json()
    pagesFetched++
    totalResults = data?.meta?.total ?? totalResults
    const page = (data?.data ?? []).map(d => d?.attributes).filter(Boolean)
    items = items.concat(page.map(dataciteToCrossrefItem))
    if (page.length < size || items.length >= maxItems || (totalResults != null && items.length >= totalResults)) break
  }
  if (!items.length) return { status: 404, totalResults: 0, items: [], error: null, pagesFetched }
  return { status: 200, totalResults, items: items.slice(0, maxItems), error: null, pagesFetched }
}

/**
 * DOI resolution check — HEAD-equivalent (follows manually, only reading
 * the redirect target, never the destination page's own body, so this
 * check is unaffected by a publisher platform's own bot-blocking on the
 * ARTICLE page, which is a separate question from "does the DOI itself
 * resolve"). Feeds Dimension 3's `doi_resolution_reliability` item.
 * @param {string} doi
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<{ doi: string, resolved: boolean, http_status: number|null, error: string|null }>}
 */
export async function checkDoiResolution(doi, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = 10000 } = opts
  const url = `https://doi.org/${encodeURIComponent(doi)}`
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    // doi.org answers a resolvable DOI with a 3xx to the publisher's
    // landing page -- that redirect existing is the resolution signal, not
    // whatever the target page itself later returns (which may be 403'd by
    // the SAME bot-blocking the Evidence ETL already documented separately).
    const resolved = res.status >= 300 && res.status < 400
    return { doi, resolved, http_status: res.status, error: null }
  } catch (err) {
    return { doi, resolved: false, http_status: null, error: err?.message ?? String(err) }
  }
}

/**
 * OAI-PMH endpoint liveness/shape check — feeds Dimension 3's
 * `oai_pmh_schema_org_machine_readable` item. Only journals with a known
 * `oai_base_url` on their corpus record (not every Core Collection journal
 * has one) are checkable this way; callers without one must resolve that
 * item as `unknown`, never `not_met` (an untried check is not a confirmed
 * absence).
 * @param {string} oaiBaseUrl
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, http_status: number|null, error: string|null }>}
 */
export async function checkOaiPmhEndpoint(oaiBaseUrl, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = 10000 } = opts
  const url = `${oaiBaseUrl}${oaiBaseUrl.includes('?') ? '&' : '?'}verb=Identify`
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, http_status: res.status, error: `HTTP ${res.status}` }
    const body = await res.text()
    // Conservative, real-shape check: a genuine OAI-PMH Identify response
    // has an <Identify> element and no top-level <error> element -- a
    // server that returns 200 with an unrelated HTML page (a common
    // misconfigured-URL failure mode) must not read as "machine-readable
    // OAI-PMH available."
    const ok = /<Identify[\s>]/i.test(body) && !/<error\b/i.test(body)
    return { ok, http_status: res.status, error: ok ? null : 'response did not look like a valid OAI-PMH Identify response' }
  } catch (err) {
    return { ok: false, http_status: null, error: err?.message ?? String(err) }
  }
}
