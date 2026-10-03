/**
 * Crossref policy signals — what a journal's own Crossref deposits say
 * about practices the site-crawl evidence items ask about, for journals
 * whose website refuses the crawler. TRIAL ONLY (scripts/
 * crossref-policy-signals.mjs): nothing here feeds a published score. Using
 * these signals for AJR would change which evidence counts for an item, a
 * methodology change that needs AJR-SPEC.md and a version bump first.
 *
 * Pure functions; the fetching happens in the script.
 *
 * Per article (a raw Crossref work record):
 *   license        - a license URL is deposited
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
    license: Array.isArray(work?.license) && work.license.some(l => typeof l?.URL === 'string' && l.URL),
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
 * carry it. A proposal to measure, not a rule in force.
 */
export const CANDIDATE_MAPPING = Object.freeze({
  copyright_licensing: ['license'],
  access_model_disclosure: ['license'],
  corrections_retractions_policy: ['crossmark'],
  peer_review_process_disclosed: ['review_dates', 'open_review'],
  conflict_of_interest_policy: ['coi'],
  data_availability_sharing: ['data'],
})
export const MIN_SHARE = 0.5
export const MIN_ARTICLES = 20

/**
 * Per evidence item of CANDIDATE_MAPPING: the share of articles carrying
 * at least one of its signals (the OR is taken per article, so two
 * signals on disjoint sets of articles add up).
 * @param {object[]} works
 * @returns {{ articles: number } & Record<string, number>} shares 0..1
 */
export function journalItemShares(works) {
  const out = { articles: works.length }
  const signals = works.map(articleSignals)
  for (const [id, keys] of Object.entries(CANDIDATE_MAPPING)) {
    out[id] = works.length ? Math.round((signals.filter(s => keys.some(k => s[k])).length / works.length) * 1000) / 1000 : 0
  }
  return out
}

/**
 * Upgrades only items the crawl could not resolve (unknown / blocked) to
 * met where the journal's Crossref signal supports it; never overrides a
 * met or not_met the site gave.
 * @param {{ id: string, weight: number, status: string }[]} items - site evidence items
 * @param {ReturnType<typeof journalItemShares>} itemShares
 * @returns {{ items: object[], upgraded: string[] }}
 */
export function applyCrossrefSignals(items, itemShares) {
  const upgraded = []
  if ((itemShares?.articles ?? 0) < MIN_ARTICLES) return { items, upgraded }
  const out = items.map(i => {
    if (!CANDIDATE_MAPPING[i.id] || !['unknown', 'blocked'].includes(i.status)) return i
    if ((itemShares[i.id] ?? 0) < MIN_SHARE) return i
    upgraded.push(i.id)
    return { ...i, status: 'met', source: 'crossref_trial' }
  })
  return { items: out, upgraded }
}
