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
 * fetch_status -> unknown/blocked mapping is NOT reimplemented here --
 * this module calls evidence-coverage.mjs's classifyFetchOutcomeStatus()
 * so there is exactly one place that decision is made.
 */

import { classifyFetchOutcomeStatus } from './evidence-coverage.mjs'

/** @typedef {{ url: string, fetch_status: string, http_status: number|null, body: string|null }} FetchedPage */

function hasAny(text, patterns) {
  if (!text) return false
  const lower = text.toLowerCase()
  return patterns.some(p => lower.includes(p))
}

/**
 * Evidence Coverage weights below match AJR-E-1.1-SPEC.md's item tables
 * exactly (Dimension 1 §3, Dimension 2 §4, Dimension 7 §9) -- these are
 * not independently invented weights, they're the already-frozen spec
 * values, so a dimensionScore() computed from this module's output lines
 * up with the spec without a separate reconciliation step.
 */
export const EVIDENCE_CRITERIA = Object.freeze([
  // --- Dimension 1: Editorial Governance & Peer Review (AJR-E-1.1-SPEC.md § 3) ---
  { id: 'aims_scope', dimension: 'editorial_governance', weight: 2,
    patterns: ['aim and scope', 'aims and scope', 'about the journal', 'journal focus', 'focus and scope', '宗旨', '办刊宗旨', '期刊简介', '关于本刊'] },
  { id: 'editorial_board', dimension: 'editorial_governance', weight: 3,
    patterns: ['editorial board', 'editorial team', 'board of editors', 'editorial masthead', '编辑委员会', '编委会'] },
  { id: 'editor_identity', dimension: 'editorial_governance', weight: 2,
    patterns: ['editor-in-chief', 'editor in chief', 'chief editor', 'associate editor', 'affiliation', '主编', '副主编', '编辑'] },
  { id: 'peer_review_disclosed', dimension: 'editorial_governance', weight: 4,
    patterns: ['peer review', 'peer-review', 'peer reviewed', 'double-blind', 'single-blind', 'double blind review', '同行评审', '同行评议', '双盲评审', '盲审'] },
  { id: 'reviewer_guidelines', dimension: 'editorial_governance', weight: 2,
    patterns: ['reviewer guideline', 'review guideline', 'guide for reviewer', 'reviewer instructions', '审稿指南', '审稿人指南', '评审指南'] },
  { id: 'complaints_appeals', dimension: 'editorial_governance', weight: 2,
    patterns: ['complaint', 'appeal', 'grievance', 'dispute resolution', '投诉', '申诉', '异议'] },

  // --- Dimension 2: Research Integrity (AJR-E-1.1-SPEC.md § 4) ---
  { id: 'publication_ethics', dimension: 'research_integrity', weight: 3,
    patterns: ['publication ethics', 'ethics statement', 'ethics and misconduct', 'misconduct policy', 'code of conduct', '出版伦理', '学术不端', '科研诚信'] },
  { id: 'corrections_retractions', dimension: 'research_integrity', weight: 3,
    patterns: ['retraction', 'correction policy', 'errata', 'erratum', 'corrigendum', '勘误', '撤稿', '更正声明'] },
  { id: 'authorship_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['authorship criteria', 'authorship policy', 'contributorship', 'author contribution', 'credit taxonomy', '作者身份', '署名规范', '作者贡献'] },
  { id: 'coi_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['conflict of interest', 'competing interest', 'coi disclosure', '利益冲突', '利益相关'] },
  { id: 'plagiarism_policy', dimension: 'research_integrity', weight: 2,
    patterns: ['plagiarism', 'similarity check', 'turnitin', 'ithenticate', 'similarity index', '抄袭', '查重', '相似度检测', '剽窃'] },
  { id: 'human_animal_ethics', dimension: 'research_integrity', weight: 1,
    patterns: ['informed consent', 'animal welfare', 'institutional review board', 'ethics committee approval', 'human subjects', '知情同意', '伦理委员会', '动物福利'] },
  { id: 'data_availability', dimension: 'research_integrity', weight: 1,
    patterns: ['data availability', 'data sharing', 'data accessibility', 'data policy', '数据可用性', '数据共享', '数据政策'] },
  { id: 'ai_use_policy', dimension: 'research_integrity', weight: 1,
    patterns: ['use of ai', 'artificial intelligence policy', 'generative ai', 'chatgpt', 'large language model', 'ai-assisted', '人工智能政策', '生成式人工智能', '大语言模型'] },

  // --- Dimension 7: Transparency & Access Policy (AJR-E-1.1-SPEC.md § 9) ---
  { id: 'apc_disclosure', dimension: 'transparency', weight: 2,
    patterns: ['article processing charge', 'apc', 'publication fee', 'processing fee', 'no fee', 'fee waiver', '版面费', '发表费', '审稿费', '费用减免'] },
  { id: 'copyright_licensing', dimension: 'transparency', weight: 2,
    patterns: ['creative commons', 'cc by', 'copyright notice', 'copyright policy', '知识共享', '版权声明', '版权政策'] },
  { id: 'access_model_disclosure', dimension: 'transparency', weight: 1,
    patterns: ['open access', 'subscription', 'hybrid journal', 'access model', '开放获取', '开放存取', '订阅'] },
  { id: 'publisher_contact', dimension: 'transparency', weight: 2,
    patterns: ['publisher', 'contact us', 'contact information', 'mailing address', '出版商', '联系我们', '联系方式'] },
  { id: 'author_guidelines', dimension: 'transparency', weight: 1,
    patterns: ['author guideline', 'guide for authors', 'submission guideline', 'manuscript preparation', '投稿指南', '作者指南', '稿约'] },
  { id: 'advertising_disclosure', dimension: 'transparency', weight: 1,
    patterns: ['advertising policy', 'sponsorship', 'advertisement disclosure', '广告政策', '赞助声明'] },
])

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
 * @returns {{ id: string, weight: number, status: string, source_url: string|null, retrieved_at: string|null }}
 */
export function resolveCriterion(criterion, fetchedPages) {
  const okPages = fetchedPages.filter(p => p.fetch_status === 'ok')
  const { matched, sourceUrl } = detectCriterionInPages(criterion, fetchedPages)

  if (matched) {
    return { id: criterion.id, weight: criterion.weight, status: 'met', source_url: sourceUrl, retrieved_at: fetchedPages.find(p => p.url === sourceUrl)?.retrieved_at ?? null }
  }

  if (okPages.length > 0) {
    // At least one page fetched successfully but the pattern never
    // matched anywhere -- a real, resolved "not disclosed" answer, not a
    // fetch problem. Cite the homepage (or first ok page) as the checked
    // source so a reader can go verify.
    return { id: criterion.id, weight: criterion.weight, status: 'not_met', source_url: okPages[0].url, retrieved_at: okPages[0].retrieved_at }
  }

  // Nothing fetched successfully at all for this journal -- fall back to
  // the worst (most-blocking) outcome among every attempted fetch, via
  // evidence-coverage.mjs's single shared outcome->status mapping.
  const outcomes = fetchedPages.map(p => p.fetch_status === 'ok' ? null : (p.http_status ?? p.fetch_status))
  const worstOutcome = outcomes.find(o => o === 403 || o === 429 || o === 'forbidden' || o === 'rate_limited') ?? outcomes[0] ?? null
  const normalizedOutcome = worstOutcome === 'forbidden' ? 403 : worstOutcome === 'rate_limited' ? 429 : worstOutcome === 'timeout' ? 'timeout' : worstOutcome === 'network_error' ? 'network_error' : worstOutcome
  const status = fetchedPages.length === 0 ? 'unknown' : classifyFetchOutcomeStatus(normalizedOutcome)
  return { id: criterion.id, weight: criterion.weight, status, source_url: null, retrieved_at: null }
}

/**
 * @param {FetchedPage[]} fetchedPages - every page fetched for one journal.
 * @returns {ReturnType<typeof resolveCriterion>[]} one item per
 *   EVIDENCE_CRITERIA entry, ready for evidence-coverage.mjs.
 */
export function resolveAllCriteria(fetchedPages) {
  return EVIDENCE_CRITERIA.map(c => resolveCriterion(c, fetchedPages))
}
