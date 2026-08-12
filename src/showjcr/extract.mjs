/**
 * Per-family column allow-lists for ShowJCR's CSVs (hitfyd/ShowJCR, GPL-3.0
 * for the *code* in that repo — the data files it bundles are a separate
 * matter, see below).
 *
 * COPYRIGHT REASONING — read before adding a column to any extractor here.
 *
 * JCR (Journal Citation Reports) impact factors/quartiles/ranks are
 * Clarivate's proprietary analysis product. The CAS Journal Partition
 * Table (中科院分区表, FQBJCR* files) partition tiers are a licensed CAS
 * product. POSI must never import, store, redistribute, or display those
 * *values* — not the IF number, not the JCR quartile letter, not the CAS
 * partition tier — regardless of what license covers ShowJCR's own code.
 * Bundling them in a GPL repo doesn't relicense Clarivate's or CAS's
 * analysis; POSI re-publishing them would still be republishing someone
 * else's paid product.
 *
 * What's fine to use: plain bibliographic identity — journal name, ISSN,
 * EISSN. Those are facts, not the proprietary product. That's ALL any
 * extractor below pulls from the JCR/FQBJCR/XR (rising-star) families.
 *
 * Two families get more than identity, deliberately:
 *   - CCF's own recommendation tier/category (CCF2019/2022/2026-UTF8.csv,
 *     CCFT2022/2025-UTF8.csv): this is CCF's own IP, published openly on
 *     ccf.org.cn with no paywall, and citing it is standard practice in
 *     Chinese CS academia. Still don't redisplay it as if POSI computed it.
 *   - The early-warning list (GJQKYJMD*.csv): a public advisory list; its
 *     warning-reason field is the entire point of citing it.
 *
 * If a ShowJCR file gets a new column in a future run, do NOT widen an
 * extractor to grab it without re-reading this comment and confirming the
 * new column isn't an IF/quartile/rank/partition-tier value.
 */

/**
 * @typedef {{ journal: string, issn: string | null, eissn: string | null }} IdentityFields
 */

function clean(v) {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

/** ISSNs in these files are inconsistently hyphenated/cased; normalize.mjs's
 * normalizeIssn() does the real validation later — this just trims/upcases
 * so lookups aren't defeated by whitespace. */
function cleanIssn(v) {
  const t = clean(v)
  return t ? t.toUpperCase() : null
}

/**
 * JCR2020-UTF8.csv .. JCR2025-UTF8.csv
 * Columns (2025 shape): Journal,ISSN,EISSN,Web of Science,IF(2025),
 * Category_1,IF Quartile(2025)_1,IF Rank(2025)_1,Category_2,... (repeats
 * per WoS category). Only Journal/ISSN/EISSN are extracted.
 * @returns {IdentityFields[]}
 */
export function extractJcr(rows) {
  return rows
    .map(r => ({ journal: clean(r.Journal), issn: cleanIssn(r.ISSN), eissn: cleanIssn(r.EISSN) }))
    .filter(r => r.journal)
}

/**
 * FQBJCR2021/2022/2023/2025-UTF8.csv (中科院分区表, CAS Journal Partition Table)
 * Columns (2025 shape): Journal,年份,ISSN/EISSN,Review,OA Journal
 * Index（OAJ）,Open Access,Web of Science,标注,大类,大类分区,Top,小类1,
 * 小类1分区,... — note ISSN and EISSN are combined into a single
 * "ISSN/EISSN" column (e.g. "2649-664X/2649-6100"), unlike the JCR files.
 * Only Journal + the split ISSN/EISSN pair are extracted; every 分区
 * (partition) and Top column is discarded.
 * @returns {IdentityFields[]}
 */
export function extractCasPartition(rows) {
  return rows
    .map(r => {
      const [issn, eissn] = (r['ISSN/EISSN'] ?? '').split('/').map(clean)
      return { journal: clean(r.Journal), issn: issn ? issn.toUpperCase() : null, eissn: eissn ? eissn.toUpperCase() : null }
    })
    .filter(r => r.journal)
}

/**
 * XR2026-UTF8.csv (新锐期刊, "rising star" journals)
 * Columns include Journal,年份,预警标记,刊名,中文刊名,CN,ISSN,EISSN,
 * 出版机构,语种,期刊类型,数据库,标注,大类英文名,大类中文名,
 * 大类新锐分区,Top,... (separate ISSN/EISSN columns, unlike FQBJCR).
 * Only Journal/ISSN/EISSN are extracted; the 新锐分区 (rising-star
 * partition) and Top columns are discarded like any other partition tier.
 * @returns {IdentityFields[]}
 */
export function extractRisingStar(rows) {
  return rows
    .map(r => ({ journal: clean(r.Journal), issn: cleanIssn(r.ISSN), eissn: cleanIssn(r.EISSN) }))
    .filter(r => r.journal)
}

/**
 * GJQKYJMD202{0,1,3,4,5}.csv (国际期刊预警名单, international early-warning list)
 * Columns vary by year: always "Journal" + one warning column whose name
 * changes ("预警等级（2020）", "预警原因（2024）", ...). No ISSN column in
 * any year seen so far, so this family can only be cross-checked by title.
 * This is a public advisory list, so unlike JCR/FQBJCR the warning reason
 * itself is kept (it's the point of citing this file), not just identity.
 * @returns {{ journal: string, warningReason: string | null }[]}
 */
export function extractEarlyWarning(rows, header) {
  const warningCol = header.find(h => h !== 'Journal' && h.includes('预警'))
  return rows
    .map(r => ({ journal: clean(r.Journal), warningReason: warningCol ? clean(r[warningCol]) : null }))
    .filter(r => r.journal)
}

/**
 * CCF2019/2022/2026-UTF8.csv (CCF international journal/conference directory)
 * Columns (2026 shape): 刊物名称,Journal,年份,出版社,网址,领域,
 * CCF推荐类别（国际学术刊物/会议）,CCF推荐类型. No ISSN column, so this
 * family is cross-checked by title only. CCF's own recommendation
 * category/tier is CCF's IP (published openly, standard to cite), not
 * Clarivate's or CAS's, so it's kept alongside identity.
 * @returns {{ journal: string, chineseName: string | null, category: string | null, tier: string | null }[]}
 */
export function extractCcf(rows) {
  return rows
    .map(r => {
      const chineseName = clean(r['刊物名称'] ?? r['刊物简称'])
      return {
        // A handful of rows (conference abbreviations with no full English
        // name) have a blank Journal column — fall back to the Chinese/
        // short name rather than silently dropping the row's identity.
        journal: clean(r.Journal) ?? chineseName,
        chineseName,
        category: clean(r['CCF推荐类别（国际学术刊物/会议）'] ?? r['CCF推荐类别']),
        tier: clean(r['CCF推荐类型']),
      }
    })
    .filter(r => r.journal)
}

/**
 * CCFT2022/2025-UTF8.csv (计算领域高质量科技期刊分级目录 — CCF's Chinese-
 * language journal tier list)
 * Columns (2025 shape): 中文刊名,Journal,CN号,语种,主办单位,CCF推荐类别,
 * T分区. "CN号" is China's domestic serial number, not an ISSN, so this
 * family is also cross-checked by title only. T分区 (T1/T2/T3) is CCF's
 * own tier, kept for the same reason as extractCcf's tier field.
 * @returns {{ journal: string, chineseName: string | null, category: string | null, tier: string | null }[]}
 */
export function extractCcfT(rows) {
  return rows
    .map(r => {
      const chineseName = clean(r['中文刊名'])
      return {
        // Most rows here are Chinese-language-only journals with no
        // English Journal name at all — fall back to 中文刊名 so this
        // majority of the file isn't dropped for lacking an English title.
        journal: clean(r.Journal) ?? chineseName,
        chineseName,
        category: clean(r['CCF推荐类别']),
        tier: clean(r['T分区']),
      }
    })
    .filter(r => r.journal)
}

/**
 * Family registry: filename pattern (to find files in a directory listing),
 * the extractor to run on that family's latest-year CSV, and whether the
 * family carries ISSNs (determines which cross-check strategy applies —
 * see match.mjs).
 */
export const FAMILIES = [
  { name: 'jcr', label: 'JCR (Journal Citation Reports)', pattern: /^JCR(\d{4})-UTF8\.csv$/, extract: extractJcr, hasIssn: true },
  { name: 'cas_partition', label: 'CAS Journal Partition Table (中科院分区表)', pattern: /^FQBJCR(\d{4})-UTF8\.csv$/, extract: extractCasPartition, hasIssn: true },
  { name: 'rising_star', label: 'Rising-star journals (新锐期刊)', pattern: /^XR(\d{4})-UTF8\.csv$/, extract: extractRisingStar, hasIssn: true },
  { name: 'early_warning', label: 'International early-warning list (国际期刊预警名单)', pattern: /^GJQKYJMD(\d{4})\.csv$/, extract: extractEarlyWarning, hasIssn: false },
  { name: 'ccf', label: 'CCF recommended journal/conference directory', pattern: /^CCF(\d{4})-UTF8\.csv$/, extract: extractCcf, hasIssn: false },
  { name: 'ccf_t', label: 'CCF Chinese-language journal tier list (T分区)', pattern: /^CCFT(\d{4})-UTF8\.csv$/, extract: extractCcfT, hasIssn: false },
]

/**
 * Picks the highest-year filename matching a family's pattern out of a
 * directory listing (an array of filenames). Returns null if none match.
 * @returns {{ filename: string, year: number } | null}
 */
export function pickLatestFile(filenames, pattern) {
  let best = null
  for (const name of filenames) {
    const m = name.match(pattern)
    if (!m) continue
    const year = parseInt(m[1], 10)
    if (!best || year > best.year) best = { filename: name, year }
  }
  return best
}
