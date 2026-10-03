/**
 * Fetches the article sample crossref-policy-signals.mjs reads: a
 * journal's newest Crossref journal articles published in the last three
 * years up to the given date (no forthcoming records), at most `rows`,
 * from its first distinct ISSN that has any. Every attempt is kept; a
 * failure is reported when no ISSN yields articles and one of them did not
 * answer cleanly (200 or 404).
 */
import { fetchCrossrefWorksPage } from './works-fetch.mjs'
import { CROSSREF_POLICY_SELECT_FIELDS } from './crossref-policy-signals.mjs'

/**
 * @param {{ issn_online?: string|null, issn_print?: string|null }} journal
 * @param {{ rows?: number, now?: Date, fetchPage?: typeof fetchCrossrefWorksPage }} [opts]
 * @returns {Promise<{ works: object[], attempts: { issn: string, status: number|null, error: string|null }[], failed: boolean, since: string, until: string, sourceUrl: string|null }>}
 */
export async function fetchCrossrefPolicySample(journal, { rows = 100, now = new Date(), fetchPage = fetchCrossrefWorksPage } = {}) {
  const until = now.toISOString().slice(0, 10)
  const since = new Date(Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10)
  const issns = [...new Set([journal.issn_online, journal.issn_print].filter(Boolean).map(i => String(i).trim().toUpperCase()))]
  const filter = `type:journal-article,from-pub-date:${since},until-pub-date:${until}`
  let works = []
  let sourceUrl = null
  const attempts = []
  for (const issn of issns) {
    const page = await fetchPage(issn, { rows, offset: 0, sort: 'published', order: 'desc', filter, selectFields: CROSSREF_POLICY_SELECT_FIELDS })
    attempts.push({ issn, status: page.status, error: page.error ?? null })
    if (page.items.length) {
      works = page.items
      sourceUrl = `https://api.crossref.org/journals/${issn}/works?filter=${filter}&sort=published&order=desc&rows=${rows}`
      break
    }
  }
  const failed = !works.length && attempts.some(a => a.status !== 200 && a.status !== 404)
  return { works, attempts, failed, since, until, sourceUrl }
}
