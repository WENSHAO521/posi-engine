import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/showjcr/csv.mjs'
import {
  extractJcr, extractCasPartition, extractRisingStar, extractEarlyWarning, extractCcf, extractCcfT, pickLatestFile,
} from '../src/showjcr/extract.mjs'

test('extractJcr pulls only Journal/ISSN/EISSN, discarding IF/quartile/rank columns', () => {
  const csv = 'Journal,ISSN,EISSN,Web of Science,IF(2025),Category_1,IF Quartile(2025)_1,IF Rank(2025)_1\n'
    + 'CA-A CANCER JOURNAL FOR CLINICIANS,0007-9235,1542-4863,SCIE,685.2,ONCOLOGY,Q1,1/333\n'
  const { rows } = parseCsv(csv)
  const extracted = extractJcr(rows)
  assert.deepEqual(extracted, [{ journal: 'CA-A CANCER JOURNAL FOR CLINICIANS', issn: '0007-9235', eissn: '1542-4863' }])
  // No key on the extracted record traces back to IF/quartile/rank.
  assert.deepEqual(Object.keys(extracted[0]).sort(), ['eissn', 'issn', 'journal'])
})

test('extractJcr drops rows with a blank Journal', () => {
  const { rows } = parseCsv('Journal,ISSN,EISSN\n,0000-0000,1111-1111\n')
  assert.equal(extractJcr(rows).length, 0)
})

test('extractCasPartition splits the combined ISSN/EISSN column and discards partition columns', () => {
  const csv = 'Journal,年份,ISSN/EISSN,大类,大类分区,Top\n2D Materials,2025,2053-1583/2053-1583,材料科学,"3 [168/495]",否\n'
  const { rows } = parseCsv(csv)
  const extracted = extractCasPartition(rows)
  assert.deepEqual(extracted, [{ journal: '2D Materials', issn: '2053-1583', eissn: '2053-1583' }])
})

test('extractCasPartition tolerates a missing EISSN half', () => {
  const { rows } = parseCsv('Journal,ISSN/EISSN\nSolo Journal,1234-5678\n')
  const extracted = extractCasPartition(rows)
  assert.equal(extracted[0].issn, '1234-5678')
  assert.equal(extracted[0].eissn, null)
})

test('extractRisingStar pulls Journal/ISSN/EISSN and discards the rising-star partition column', () => {
  const csv = 'Journal,ISSN,EISSN,大类新锐分区,Top\nHistria,1848-1183,1849-5699,2,否\n'
  const { rows } = parseCsv(csv)
  assert.deepEqual(extractRisingStar(rows), [{ journal: 'Histria', issn: '1848-1183', eissn: '1849-5699' }])
})

test('extractEarlyWarning finds the year-specific warning column by pattern, not a fixed name', () => {
  const csv2020 = parseCsv('Journal,预警等级（2020）\nMetals,低\n')
  const r2020 = extractEarlyWarning(csv2020.rows, csv2020.header)
  assert.deepEqual(r2020, [{ journal: 'Metals', warningReason: '低' }])

  const csv2024 = parseCsv('Journal,预警原因（2024）\nCANCERS,引用操纵\n')
  const r2024 = extractEarlyWarning(csv2024.rows, csv2024.header)
  assert.deepEqual(r2024, [{ journal: 'CANCERS', warningReason: '引用操纵' }])
})

test('extractCcf keeps journal identity plus CCF\'s own category/tier fields', () => {
  const csv = '刊物名称,Journal,年份,出版社,网址,领域,CCF推荐类别（国际学术刊物/会议）,CCF推荐类型\n'
    + 'JACM,Journal of the ACM,2026,ACM,http://example.com,交叉/综合/新兴,推荐国际学术刊物,A类\n'
  const { rows } = parseCsv(csv)
  assert.deepEqual(extractCcf(rows), [{
    journal: 'Journal of the ACM', chineseName: 'JACM', category: '推荐国际学术刊物', tier: 'A类',
  }])
})

test('extractCcf falls back to the Chinese/short name when Journal (English) is blank, instead of dropping the row', () => {
  const csv = '刊物名称,Journal,年份,出版社,网址,领域,CCF推荐类别（国际学术刊物/会议）,CCF推荐类型\n'
    + 'HotSec,,2026,USENIX,http://example.com,网络与信息安全,推荐国际学术会议,C类\n'
  const { rows } = parseCsv(csv)
  assert.deepEqual(extractCcf(rows), [{
    journal: 'HotSec', chineseName: 'HotSec', category: '推荐国际学术会议', tier: 'C类',
  }])
})

test('extractCcfT keeps journal identity plus the T-tier field', () => {
  const csv = '中文刊名,Journal,CN号,语种,主办单位,CCF推荐类别,T分区\n'
    + '软件学报,Journal of Software,11-2560/TP,中文,中国科学院软件研究所,计算领域高质量科技期刊分级目录,T1\n'
  const { rows } = parseCsv(csv)
  assert.deepEqual(extractCcfT(rows), [{
    journal: 'Journal of Software', chineseName: '软件学报', category: '计算领域高质量科技期刊分级目录', tier: 'T1',
  }])
})

test('extractCcfT falls back to 中文刊名 for Chinese-only journals with no English Journal field (the majority of this file)', () => {
  const csv = '中文刊名,Journal,CN号,语种,主办单位,CCF推荐类别,T分区\n'
    + '计算机学报,,11-1826/TP,中文,中国计算机学会,计算领域高质量科技期刊分级目录（2025）,T1\n'
  const { rows } = parseCsv(csv)
  assert.deepEqual(extractCcfT(rows), [{
    journal: '计算机学报', chineseName: '计算机学报', category: '计算领域高质量科技期刊分级目录（2025）', tier: 'T1',
  }])
})

test('pickLatestFile picks the highest year matching a family pattern', () => {
  const files = ['JCR2020-UTF8.csv', 'JCR2025-UTF8.csv', 'JCR2023-UTF8.csv', 'FQBJCR2025-UTF8.csv']
  assert.deepEqual(pickLatestFile(files, /^JCR(\d{4})-UTF8\.csv$/), { filename: 'JCR2025-UTF8.csv', year: 2025 })
})

test('pickLatestFile is anchored so it does not match a differently-prefixed family', () => {
  const files = ['CCFT2025-UTF8.csv', 'CCFChinese2019-UTF8.csv', 'CCF2026-UTF8.csv']
  assert.deepEqual(pickLatestFile(files, /^CCF(\d{4})-UTF8\.csv$/), { filename: 'CCF2026-UTF8.csv', year: 2026 })
})

test('pickLatestFile returns null when nothing matches', () => {
  assert.equal(pickLatestFile(['other.csv'], /^JCR(\d{4})-UTF8\.csv$/), null)
})
