/**
 * Yearly output for AJR-M Dimension 2 (five-year continuity, output
 * stability): works per publication year from the journal's OpenAlex
 * source record (`counts_by_year`, the last ten years). One request per
 * journal, free, no key.
 */

export const OPENALEX_BASE = 'https://api.openalex.org'
const DEFAULT_MAILTO = 'posi@panorama-sg.com'

/**
 * @param {string|null} openalexSourceId - e.g. "S5407047583" or a full https://openalex.org/S… URL
 * @param {{ fetchImpl?: Function, mailto?: string, timeoutMs?: number, maxAttempts?: number }} [opts]
 * @returns {Promise<{ counts_by_year: Object<string,number>|null, error: string|null }>}
 *   counts_by_year maps year -> works_count; null when the source could not
 *   be read (never an empty map standing in for a failed request).
 */
export async function fetchCountsByYear(openalexSourceId, opts = {}) {
  const { fetchImpl = fetch, mailto = DEFAULT_MAILTO, timeoutMs = 15000, maxAttempts = 3 } = opts
  const id = (openalexSourceId ?? '').replace(/^https?:\/\/openalex\.org\//, '')
  if (!/^S\d+$/.test(id)) return { counts_by_year: null, error: 'no OpenAlex source id' }
  const url = `${OPENALEX_BASE}/sources/${id}?select=counts_by_year&mailto=${encodeURIComponent(mailto)}`
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 404) return { counts_by_year: null, error: 'OpenAlex source not found' }
      if (!res.ok) { lastError = `HTTP ${res.status}`; if (res.status < 500 && res.status !== 429) break }
      else {
        const body = await res.json()
        const counts = {}
        for (const c of body.counts_by_year ?? []) counts[c.year] = c.works_count ?? 0
        return { counts_by_year: counts, error: null }
      }
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt))
  }
  return { counts_by_year: null, error: lastError }
}
