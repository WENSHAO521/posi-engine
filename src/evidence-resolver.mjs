/**
 * Evidence resolver — Evidence ETL v1's third stage. Maps a journal's set
 * of fetched pages (evidence-fetch.mjs output) to a per-criterion Evidence
 * Coverage item (evidence-coverage.mjs's seven-state model: met / not_met
 * / unknown / blocked / not_applicable / conflicted / stale), ready to feed
 * into evidenceCoverage()/dimensionScore()/ratingEligibility().
 *
 * Content detection itself is still bilingual-pattern matching (English +
 * Chinese) -- the framework's requirement is about the OUTPUT being one of
 * the seven canonical states, not that pattern matching as a detection
 * technique is banned. The bilingual pattern lists below for the criteria
 * that already existed in the website repo's scripts/rate-early-stage.mjs
 * are carried over verbatim (not re-derived) -- they were verified
 * directly against real Core Collection journals, including a documented
 * regression where English-only matching silently failed every
 * Chinese-language journal despite the policy content being plainly
 * present on the page.
 *
 * CRITICAL, review-caught bug fixed here (not the original design): a
 * criterion must never resolve `not_met` just because *some* page on the
 * journal's site fetched OK -- "homepage 200, /publication-ethics 403"
 * must resolve `publication_ethics` as `blocked`, not `not_met`, because
 * the page most likely to actually contain that policy is the one that
 * failed. `resolveCriterion()` below is criterion-aware: it only concludes
 * `not_met` once every page *relevant to this specific criterion* that was
 * attempted either succeeded (and didn't match) or came back a clean 404
 * (a guessed path that simply doesn't exist here, not a fetch problem). A
 * blocking or unknown-worthy outcome among the relevant set wins over a
 * confident absence -- see evidence-fetch.mjs's BLOCKING_STATUSES /
 * UNKNOWN_STATUSES / CLEAN_ABSENCE_STATUSES, which this module reads
 * directly rather than going through evidence-coverage.mjs's coarser
 * fetch-outcome mapping (which only sees a single winning outcome per
 * journal, not per criterion).
 */

import { BLOCKING_STATUSES, UNKNOWN_STATUSES } from './evidence-fetch.mjs'

function hasAny(text, patterns) {
  if (!text) return false
  const lower = text.toLowerCase()
  return patterns.some(p => lower.includes(p))
}

/** Path substrings (matched against a fetched URL's pathname, case-
 * insensitive) that are ALWAYS considered relevant to every criterion --
 * a journal's homepage and its OJS "About the Journal" landing/submissions
 * pages frequently bundle several policies onto one page even when a
 * dedicated criterion-specific path also exists. Deliberately does NOT
 * include /about/editorialTeam or /about/editorialMasthead: those pages
 * are specifically the editorial-board roster, not a general policy
 * bundle -- they're already listed in editorial_board's/editor_identity's
 * own `relevantPathKeywords` below, and including them here would let a
 * fetch failure on a narrow board-roster page wrongly mark unrelated
 * criteria like `advertising_disclosure` or `ai_use_policy` unresolved. */
const ALWAYS_RELEVANT_PATH_SUBSTRINGS = ['/about', '/about/submissions']

/**
 * Evidence Coverage weights below match AJR-E-1.1-SPEC.md's item tables
 * exactly (Dimension 1 §3, Dimension 2 §4, Dimension 7 §9) -- these are
 * not independently invented weights, they're the already-frozen spec
 * values, so a dimensionScore() computed from this module's output lines
 * up with the spec without a separate reconciliation step.
 *
 * `relevantPathKeywords`: path substrings (beyond the always-relevant set
 * above) considered specifically about this criterion -- used to decide
 * whether a failed fetch is evidence this criterion is unresolved
 * (relevant page failed) or just an irrelevant miss elsewhere on the site.
 */
export const EVIDENCE_CRITERIA = Object.freeze([
  // --- Dimension 1: Editorial Governance & Peer Review (AJR-E-1.1-SPEC.md § 3) ---
  { id: 'aims_scope', dimension: 'editorial_governance', weight: 2,
    patterns: ['aim and scope', 'aims and scope', 'about the journal', 'journal focus', 'focus and scope', '宗旨', '办刊宗旨', '期刊简介', '关于本刊'],
    relevantPathKeywords: ['aims-and-scope', 'aim-and-scope'] },
  { id: 'editorial_board', dimension: 'editorial_governance', weight: 3,
    patterns: ['editorial board', 'editorial team', 'board of editors', 'editorial masthead', '编辑委员会', '编委会'],
    relevantPathKeywords: ['editorial-board', 'editorialteam', 'editorialmasthead'] },
  { id: 'editor_identity', dimension: 'editorial_governance', weight: 2,
    patterns: ['editor-in-chief', 'editor in chief', 'chief editor', 'associate editor', 'affiliation', '主编', '副主编', '编辑'],
    relevantPathKeywords: ['editorial-board', 'editorialteam', 'editorialmasthead'] },
  { id: 'peer_review_disclosed', dimension: 'editorial_governance', weight: 4,
    patterns: ['peer review', 'peer-review', 'peer reviewed', 'double-blind', 'single-blind', 'double blind review', '同行评审', '同行评议', '双盲评审', '盲审'],
    relevantPathKeywords: ['peer-review', 'editorial-policies'] },
  { id: 'reviewer_guidelines', dimension: 'editorial_governance', weight: 2,
    patterns: ['reviewer guideline', 'review guideline', 'guide for reviewer', 'reviewer instructions', '审稿指南', '审稿人指南', '评审指南'],
    relevantPathKeywords: ['peer-review', 'editorial-policies', 'for-authors'] },
  { id: 'complaints_appeals', dimension: 'editorial_governance', weight: 2,
    patterns: ['complaint', 'appeal', 'grievance', 'dispute resolution', '投诉', '申诉', '异议'],
    relevantPathKeywords: ['editorial-policies', 'publication-ethics', 'ethics'] },

  // --- Dimension 2: Research Integrity (AJR-E-1.1-SPEC.md § 4) ---
  { id: 'publication_ethics', dimension: 'research_integrity', weight: 3,
    patterns: ['publication ethics', 'ethics statement', 'ethics and misconduct', 'misconduct policy', 'code of conduct', '出版伦理', '学术不端', '科研诚信'],
    relevantPathKeywords: ['publication-ethics', 'ethics', 'editorial-policies'] },
  { id: 'corrections_retractions', dimension: 'research_integrity', weight: 3,
    patterns: ['retraction', 'correction policy', 'errata', 'erratum', 'corrigendum', '勘误', '撤稿', '更正声明'],
    relevantPathKeywords: ['publication-ethics', 'ethics', 'editorial-policies', 'corrections', 'retractions'] },
  { id: 'authorship_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['authorship criteria', 'authorship policy', 'contributorship', 'author contribution', 'credit taxonomy', '作者身份', '署名规范', '作者贡献'],
    relevantPathKeywords: ['publication-ethics', 'ethics', 'author-guidelines', 'for-authors'] },
  { id: 'coi_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['conflict of interest', 'competing interest', 'coi disclosure', '利益冲突', '利益相关'],
    relevantPathKeywords: ['publication-ethics', 'ethics', 'editorial-policies'] },
  { id: 'plagiarism_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['plagiarism', 'similarity check', 'turnitin', 'ithenticate', 'similarity index', '抄袭', '查重', '相似度检测', '剽窃'],
    relevantPathKeywords: ['publication-ethics', 'ethics', 'editorial-policies'] },
  { id: 'human_animal_ethics', dimension: 'research_integrity', weight: 1,
    patterns: ['informed consent', 'animal welfare', 'institutional review board', 'ethics committee approval', 'human subjects', '知情同意', '伦理委员会', '动物福利'],
    relevantPathKeywords: ['publication-ethics', 'ethics'] },
  { id: 'data_availability', dimension: 'research_integrity', weight: 1,
    patterns: ['data availability', 'data sharing', 'data accessibility', 'data policy', '数据可用性', '数据共享', '数据政策'],
    relevantPathKeywords: ['data-policy', 'author-guidelines', 'for-authors'] },
  { id: 'ai_use_policy', dimension: 'research_integrity', weight: 1,
    patterns: ['use of ai', 'artificial intelligence policy', 'generative ai', 'chatgpt', 'large language model', 'ai-assisted', '人工智能政策', '生成式人工智能', '大语言模型'],
    relevantPathKeywords: ['ai-policy', 'author-guidelines', 'for-authors', 'publication-ethics'] },

  // --- Dimension 7: Transparency & Access Policy (AJR-E-1.1-SPEC.md § 9) ---
  { id: 'apc_disclosure', dimension: 'transparency', weight: 2,
    patterns: ['article processing charge', 'apc', 'publication fee', 'processing fee', 'no fee', 'fee waiver', '版面费', '发表费', '审稿费', '费用减免'],
    relevantPathKeywords: ['apc', 'fees', 'for-authors', 'submissions'] },
  { id: 'copyright_licensing', dimension: 'transparency', weight: 2,
    patterns: ['creative commons', 'cc by', 'copyright notice', 'copyright policy', '知识共享', '版权声明', '版权政策'],
    relevantPathKeywords: ['copyright', 'licensing', 'for-authors'] },
  { id: 'access_model_disclosure', dimension: 'transparency', weight: 1,
    patterns: ['open access', 'subscription', 'hybrid journal', 'access model', '开放获取', '开放存取', '订阅'],
    relevantPathKeywords: ['copyright', 'licensing', 'apc'] },
  { id: 'publisher_contact', dimension: 'transparency', weight: 2,
    patterns: ['publisher', 'contact us', 'contact information', 'mailing address', '出版商', '联系我们', '联系方式'],
    relevantPathKeywords: [] },
  { id: 'author_guidelines', dimension: 'transparency', weight: 1,
    patterns: ['author guideline', 'guide for authors', 'submission guideline', 'manuscript preparation', '投稿指南', '作者指南', '稿约'],
    relevantPathKeywords: ['author-guidelines', 'for-authors', 'submissions'] },
  { id: 'advertising_disclosure', dimension: 'transparency', weight: 1,
    patterns: ['advertising policy', 'sponsorship', 'advertisement disclosure', '广告政策', '赞助声明'],
    relevantPathKeywords: [] },
])

/** @typedef {{ url: string, fetch_status: string, http_status: number|null, body: string|null }} FetchedPage */

/**
 * @param {string} url
 * @param {string|null} websiteUrl - the journal's own base URL, so the
 *   homepage itself (which may have no distinguishing path substring) is
 *   always recognized as relevant.
 * @param {string[]} relevantPathKeywords
 * @returns {boolean}
 */
function isRelevantPage(url, websiteUrl, relevantPathKeywords) {
  const normalized = url.replace(/\/+$/, '').toLowerCase()
  if (websiteUrl && normalized === websiteUrl.replace(/\/+$/, '').toLowerCase()) return true
  // Exact-suffix match, not substring-includes: "/about" must not also
  // match "/about/editorialMasthead" -- that nested page is a narrower,
  // specific page (the board roster) that should only count as relevant
  // to the criteria that actually list it in their own
  // relevantPathKeywords, not to every criterion via a loose "/about"
  // prefix match.
  if (ALWAYS_RELEVANT_PATH_SUBSTRINGS.some(p => normalized.endsWith(p))) return true
  return relevantPathKeywords.some(k => normalized.includes(k))
}

/**
 * @param {{id: string, patterns: string[]}} criterion
 * @param {FetchedPage[]} fetchedPages - only pages with fetch_status 'ok'
 *   are meaningful for content detection; others are handled by the
 *   fallback branch below.
 * @returns {{ matched: boolean, sourceUrl: string|null }}
 */
function detectCriterionInPages(criterion, fetchedPages) {
  const okPages = fetchedPages.filter(p => p.fetch_status === 'ok' && p.body)
  for (const page of okPages) {
    if (hasAny(page.body, criterion.patterns)) {
      return { matched: true, sourceUrl: page.url }
    }
  }
  return { matched: false, sourceUrl: null }
}

/**
 * @param {object} criterion - one EVIDENCE_CRITERIA entry
 * @param {FetchedPage[]} fetchedPages - every page fetched for this journal
 *   (homepage + candidate/discovered subpages), regardless of outcome.
 * @param {string|null} [websiteUrl] - the journal's base URL, for
 *   recognizing the homepage itself as always-relevant.
 * @returns {{ id: string, weight: number, status: string, source_url: string|null, retrieved_at: string|null }}
 */
export function resolveCriterion(criterion, fetchedPages, websiteUrl = null) {
  const { matched, sourceUrl } = detectCriterionInPages(criterion, fetchedPages)
  if (matched) {
    return { id: criterion.id, weight: criterion.weight, status: 'met', source_url: sourceUrl, retrieved_at: fetchedPages.find(p => p.url === sourceUrl)?.retrieved_at ?? null }
  }

  const relevantPages = fetchedPages.filter(p => isRelevantPage(p.url, websiteUrl, criterion.relevantPathKeywords))

  if (relevantPages.length === 0) {
    // Nothing plausibly about this criterion was even attempted -- not the
    // same as having checked and found nothing.
    return { id: criterion.id, weight: criterion.weight, status: 'unknown', source_url: null, retrieved_at: null }
  }

  const blocked = relevantPages.find(p => BLOCKING_STATUSES.includes(p.fetch_status))
  if (blocked) {
    return { id: criterion.id, weight: criterion.weight, status: 'blocked', source_url: null, retrieved_at: null }
  }
  const unresolved = relevantPages.find(p => UNKNOWN_STATUSES.includes(p.fetch_status))
  if (unresolved) {
    return { id: criterion.id, weight: criterion.weight, status: 'unknown', source_url: null, retrieved_at: null }
  }

  // Every relevant page attempted was either fetched OK (and searched, no
  // match) or came back a clean 404 (the guessed path just doesn't exist
  // here) -- a genuinely resolved absence.
  const okRelevant = relevantPages.find(p => p.fetch_status === 'ok')
  if (okRelevant) {
    return { id: criterion.id, weight: criterion.weight, status: 'not_met', source_url: okRelevant.url, retrieved_at: okRelevant.retrieved_at }
  }

  // Every relevant page (including the homepage, which is always in
  // relevantPages) came back a clean 404 -- meaning the homepage itself
  // 404'd, since a successful homepage fetch would already have satisfied
  // the okRelevant branch above. A dead/wrong base URL is not evidence of
  // a confident absence -- unresolved, not not_met.
  return { id: criterion.id, weight: criterion.weight, status: 'unknown', source_url: null, retrieved_at: null }
}

/**
 * @param {FetchedPage[]} fetchedPages - every page fetched for one journal.
 * @param {string|null} [websiteUrl]
 * @returns {ReturnType<typeof resolveCriterion>[]} one item per
 *   EVIDENCE_CRITERIA entry, ready for evidence-coverage.mjs.
 */
export function resolveAllCriteria(fetchedPages, websiteUrl = null) {
  return EVIDENCE_CRITERIA.map(c => resolveCriterion(c, fetchedPages, websiteUrl))
}
