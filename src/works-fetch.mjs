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
export async function fetchCrossrefWorksPage(issn, opts = {}) {
  const {
    cursor = '*', rows = 50, filter = 'type:journal-article', sort = 'published', order = 'desc',
    apiKey, mailto = DEFAULT_MAILTO, fetchImpl = fetch, timeoutMs = 15000, maxAttempts = 4,
    selectFields = WORKS_SELECT_FIELDS,
  } = opts

  const params = new URLSearchParams({
    rows: String(rows), cursor, filter, sort, order,
    select: selectFields.join(','), mailto,
  })
  if (apiKey) params.set('api_key', apiKey)
  const url = `${CROSSREF_BASE}/journals/${encodeURIComponent(issn)}/works?${params.toString()}`

  let lastError = null
  let lastStatus = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      lastStatus = res.status
      if (res.status === 404) return { status: 404, totalResults: 0, items: [], nextCursor: null, error: null }
      if (!res.ok) {
        if (isRetryableOutcome(res.status) && attempt < maxAttempts) { await sleep(2 ** attempt * 500); continue }
        return { status: res.status, totalResults: null, items: [], nextCursor: null, error: `HTTP ${res.status}` }
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
  const page = await fetchCrossrefWorksPage(issn, { ...opts, rows: 0, cursor: undefined })
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
 * first. Returns raw Crossref work objects, unnormalized — see
 * `works-resolver.mjs#normalizeCrossrefWork()` for the ajr-early-stage.mjs
 * input-contract shape.
 * @param {string} issn
 * @param {Parameters<typeof fetchCrossrefWorksPage>[1] & { maxItems?: number }} [opts]
 * @returns {Promise<{ status: number|null, totalResults: number|null, items: object[], error: string|null, pagesFetched: number }>}
 */
export async function fetchAllCrossrefWorks(issn, opts = {}) {
  const { maxItems = MAX_WORKS_FETCHED_PER_JOURNAL, rows = 50 } = opts
  let cursor = '*'
  let items = []
  let totalResults = null
  let pagesFetched = 0
  for (;;) {
    const page = await fetchCrossrefWorksPage(issn, { ...opts, cursor, rows })
    pagesFetched++
    if (page.status !== 200) {
      // A 404 legitimately means "no ISSN match" (not an error) -- surfaced
      // via status, with whatever was already collected (nothing, on the
      // first page) returned rather than discarded.
      return { status: page.status, totalResults: page.totalResults, items, error: page.error, pagesFetched }
    }
    totalResults = page.totalResults
    items = items.concat(page.items)
    const exhausted = page.items.length === 0 || !page.nextCursor || items.length >= maxItems
    if (exhausted) {
      return { status: 200, totalResults, items: items.slice(0, maxItems), error: null, pagesFetched }
    }
    cursor = page.nextCursor
  }
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
