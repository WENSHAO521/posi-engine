// Shared I/O for the GLOBAL-INDEX-1.0 harvesters: polite fetch with retry,
// and a resumable cursor loop that appends one JSON line per record.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const MAILTO = process.env.POSI_MAILTO || 'posi@panorama-sg.com'

// OpenAlex requires an API key beyond a small free daily budget per IP
// (about 1,000 requests). Set OPENALEX_API_KEY for harvesting; it is added to
// every api.openalex.org request made through getJson().
const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY || ''
function withKey(url) {
  if (!OPENALEX_API_KEY || !url.startsWith('https://api.openalex.org/')) return url
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(OPENALEX_API_KEY)}`
}

export function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
export const flag = name => process.argv.includes(`--${name}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** GET JSON, retrying 429/5xx/network errors with exponential backoff. */
export async function getJson(url, { maxAttempts = 6, timeoutMs = 30000 } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(withKey(url), { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': `POSI-global-index (mailto:${MAILTO})` } })
      if (res.ok) return await res.json()
      if (res.status === 429 && url.startsWith('https://api.openalex.org/')) {
        const body = await res.json().catch(() => ({}))
        if (body.dailyRemainingUsd === 0 || /budget/i.test(body.message ?? '')) {
          throw Object.assign(new Error(`OpenAlex daily budget exhausted${OPENALEX_API_KEY ? '' : ' (set OPENALEX_API_KEY)'}; resets in ${body.retryAfter ?? '?'}s. Progress is saved; re-run to resume.`), { fatal: true })
        }
      }
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { fatal: true })
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e
    }
    await sleep(Math.min(60000, 1000 * 2 ** attempt))
  }
  throw lastErr
}

/**
 * Cursor loop with on-disk resume.
 * @param {{ out: string, firstUrl: (cursor: string) => string, pick: (json: any) => { items: any[], next: string|null, total?: number },
 *           map: (item: any) => any, limit?: number, delayMs?: number, label: string }} o
 */
export async function harvestCursor({ out, firstUrl, pick, map, limit = Infinity, delayMs = 150, label }) {
  const statePath = `${out}.state.json`
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true })
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : { cursor: '*', written: 0, done: false }
  if (state.done) { console.log(`${label}: already complete (${state.written} records). Delete ${statePath} to redo.`); return state }
  while (state.cursor && state.written < limit) {
    const json = await getJson(firstUrl(state.cursor))
    const { items, next, total } = pick(json)
    const slice = items.slice(0, Math.max(0, limit - state.written))
    if (slice.length) appendFileSync(out, slice.map(i => JSON.stringify(map(i))).join('\n') + '\n')
    state = { cursor: items.length ? next : null, written: state.written + slice.length, total: total ?? state.total, done: false }
    writeFileSync(statePath, JSON.stringify(state))
    process.stdout.write(`\r${label}: ${state.written}${state.total ? ` / ${state.total}` : ''}   `)
    if (!items.length) break
    await sleep(delayMs)
  }
  state.done = state.written < limit
  writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write('\n')
  return state
}

export function readJsonl(path) {
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}
