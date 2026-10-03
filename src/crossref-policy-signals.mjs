/**
 * Crossref policy signals — what a journal's own Crossref deposits say
 * about practices the site-crawl evidence items ask about. From AJR-E-1.2 /
 * AJR-M-1.2 / EC-1.1 (AJR-SPEC.md § 8) they resolve, as `met`, the items
 * of CROSSREF_EVIDENCE_MAPPING that the journal's own website and the
 * publisher registry left unknown or blocked (scripts/run-evidence-etl.mjs);
 * scripts/crossref-policy-signals.mjs reports the same comparison for a
 * trial sample.
 *
 * Pure functions; the fetching is in crossref-policy-fetch.mjs.
 *
 * Per article (a raw Crossref work record):
 *   license        - a license URL deposited for the version of record or the
 *                    accepted manuscript (content-version vor / am); a
 *                    text-and-data-mining (tdm) licence alone does not count
 *   crossmark      - an update-policy (the Crossmark policy page) is deposited
 *   review_dates   - assertions give both a received and an accepted date
 *   open_review    - relation has-review (published peer review reports)
 *   coi            - an assertion about conflicts / competing interests
 *   data           - an assertion about data availability
 *   funder         - funder metadata is deposited
 */

export const CROSSREF_POLICY_SELECT_FIELDS = ['DOI', 'license', 'update-policy', 'assertion', 'relation', 'funder', 'published']

const assertionText = a => `${a?.name ?? ''} ${a?.label ?? ''} ${a?.group?.name ?? ''} ${a?.group?.label ?? ''}`.toLowerCase()

/**
 * @param {object} work - a Crossref work record
 * @returns {{ license: boolean, crossmark: boolean, review_dates: boolean, open_review: boolean, coi: boolean, data: boolean, funder: boolean }}
 */
export function articleSignals(work) {
  const as = Array.isArray(work?.assertion) ? work.assertion : []
  const has = re => as.some(a => re.test(assertionText(a)))
  return {
    license: Array.isArray(work?.license) && work.license.some(l => typeof l?.URL === 'string' && l.URL && ['vor', 'am'].includes(String(l['content-version'] ?? '').toLowerCase())),
    crossmark: typeof work?.['update-policy'] === 'string' && work['update-policy'].length > 0,
    review_dates: has(/\breceived\b/) && has(/\baccepted\b/),
    open_review: Array.isArray(work?.relation?.['has-review']) && work.relation['has-review'].length > 0,
    coi: has(/conflict|competing|declaration of interest/),
    data: has(/data (availability|access|sharing)|data_availability/),
    funder: Array.isArray(work?.funder) && work.funder.length > 0,
  }
}

/**
 * Share of a journal's sampled articles carrying each signal.
 * @param {object[]} works
 * @returns {{ articles: number } & Record<string, number>} shares 0..1
 */
export function journalSignalShares(works) {
  const keys = ['license', 'crossmark', 'review_dates', 'open_review', 'coi', 'data', 'funder']
  const out = { articles: works.length }
  for (const k of keys) out[k] = 0
  if (!works.length) return out
  for (const w of works) { const s = articleSignals(w); for (const k of keys) if (s[k]) out[k]++ }
  for (const k of keys) out[k] = Math.round((out[k] / works.length) * 1000) / 1000
  return out
}

/**
 * The trial's candidate mapping: evidence item -> signal that would count
 * as evidence for it, when at least MIN_SHARE of the sampled articles
 * carry it (AJR-SPEC.md § 8, from AJR-E-1.2). Only signals that state the
 * journal's terms count: the copyright/reuse licence of its articles, and
 * the Crossmark update policy, which is the corrections and retractions
 * policy. Review dates, reviews and authors' COI / data statements describe
 * articles, not the journal's policy or process, so they are reported
 * (journalSignalShares) but resolve nothing; neither does the access model.
 */
export const CROSSREF_EVIDENCE_MAPPING = Object.freeze({
  copyright_licensing: ['license'],
  corrections_retractions_policy: ['crossmark'],
})
export const MIN_SHARE = 0.5
export const MIN_ARTICLES = 20

/**
 * Per evidence item of CROSSREF_EVIDENCE_MAPPING: the share of articles carrying
 * at least one of its signals (the OR is taken per article, so two
 * signals on disjoint sets of articles add up).
 * @param {object[]} works
 * @returns {{ articles: number } & Record<string, number>} shares 0..1
 */
export function journalItemShares(works) {
  const out = { articles: works.length }
  const signals = works.map(articleSignals)
  for (const [id, keys] of Object.entries(CROSSREF_EVIDENCE_MAPPING)) {
    out[id] = works.length ? Math.round((signals.filter(s => keys.some(k => s[k])).length / works.length) * 1000) / 1000 : 0
  }
  return out
}

/**
 * Upgrades only items the crawl could not resolve (unknown / blocked) to
 * met where the journal's Crossref signal supports it; never overrides a
 * met or not_met the site gave. An upgraded item records its source
 * (`source: 'crossref'`, the share of articles, the query and its date).
 * @param {{ id: string, weight: number, status: string }[]} items - site evidence items
 * @param {ReturnType<typeof journalItemShares>} itemShares
 * @param {{ sourceUrl?: string|null, retrievedAt?: string|null, sampleUntil?: string|null }} [provenance] - sampleUntil: the
 *   last publication date of the sample (YYYY-MM-DD), kept on the item so a
 *   later run can tell whether carried evidence still lies in its window
 * @returns {{ items: object[], upgraded: string[] }}
 */
export function applyCrossrefSignals(items, itemShares, { sourceUrl = null, retrievedAt = null, sampleUntil = null } = {}) {
  const upgraded = []
  if ((itemShares?.articles ?? 0) < MIN_ARTICLES) return { items, upgraded }
  const out = items.map(i => {
    if (!CROSSREF_EVIDENCE_MAPPING[i.id] || !['unknown', 'blocked'].includes(i.status)) return i
    if ((itemShares[i.id] ?? 0) < MIN_SHARE) return i
    upgraded.push(i.id)
    return { ...i, status: 'met', source: 'crossref', source_url: sourceUrl, retrieved_at: retrievedAt, crossref_share: itemShares[i.id], crossref_articles: itemShares.articles, crossref_until: sampleUntil }
  })
  return { items: out, upgraded }
}
