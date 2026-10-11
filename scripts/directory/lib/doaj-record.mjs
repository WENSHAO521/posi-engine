// Turns a DOAJ journal record (the shape the DOAJ search API and the public
// data dump both use: { id, bibjson, admin, ... }) into a Discovered journal
// record. Shared by discover-journals.mjs and sync-doaj.mjs.

import { autoPqf } from './discovered-store.mjs'
import { isoToCountry } from './country-codes.mjs'

// DOAJ gives languages as ISO 639-1 codes ("EN"); records store names ("English").
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

export function languageName(language) {
  const first = [language ?? []].flat()[0]
  if (typeof first !== 'string' || !first.trim()) return null
  if (!/^[a-z]{2,3}$/i.test(first.trim())) return first.trim()
  try { return LANGUAGE_NAMES.of(first.trim().toLowerCase()) ?? first } catch { return first }
}

export function licenseLabel(bib) {
  const type = bib.license?.[0]?.type
  return typeof type === 'string' && type.trim() ? type.trim() : null
}

export function slugify(str) {
  return (str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
}

/**
 * The journal_code (and so the id and page path) of a record: its primary ISSN
 * when it has one, otherwise a slug of the title. A slug is empty for titles
 * without Latin letters and is cut to 24 characters, so two long titles can
 * share one; a record without an ISSN and without a usable slug is refused
 * instead of being given a code another journal may already hold.
 */
export function recordCode(j) {
  if (j.code) return j.code
  const issn = j.issn_online ?? j.issn_print ?? null
  if (issn) return `issn-${issn}`
  const slug = slugify(j.title)
  if (!slug) throw new Error(`Cannot derive a journal code for "${j.title}": no ISSN and no Latin letters in the title`)
  return slug
}

// ── Frequency from DOAJ publication_time_weeks ───────────────────────────────

export function weeksToFrequency(weeks) {
  if (!weeks) return ''
  if (weeks <= 1)  return 'Weekly'
  if (weeks <= 2)  return 'Biweekly'
  if (weeks <= 3)  return 'Three times a month'
  if (weeks <= 5)  return 'Monthly'
  if (weeks <= 7)  return 'Six times a year'
  if (weeks <= 9)  return 'Bimonthly'
  if (weeks <= 14) return 'Quarterly'
  if (weeks <= 20) return 'Three times a year'
  if (weeks <= 30) return 'Semiannual'
  return 'Annual'
}

// ── Inline PQF scoring (mirrors auto-pqf.mjs logic) ────────────────────────

function pqfGrade(total) {
  if (total >= 90) return 'A+'
  if (total >= 80) return 'A'
  if (total >= 70) return 'B+'
  if (total >= 60) return 'B'
  if (total >= 50) return 'C'
  if (total >= 40) return 'D'
  return 'E'
}

function scoreDoaj(bib, admin) {
  const lic = (bib.license?.[0]?.type ?? '').toLowerCase()
  const has_seal = !!(admin?.ticked)
  const has_apc = !!(bib.apc?.has_apc)
  const apc_max = bib.apc?.max ?? []
  const reviews = bib.editorial?.review_processes ?? bib.editorial?.review_process ?? []
  const reviewArr = Array.isArray(reviews) ? reviews : [reviews]
  const peer = reviewArr.some(r => String(r).toLowerCase().includes('peer'))

  // JTF /25
  let jtf = 8
  if (lic.includes('cc by 4') || lic === 'cc by') jtf += 5
  else if (lic.includes('cc by-sa') || lic.includes('cc by-nc 4')) jtf += 3
  else if (lic.includes('cc by-nd') || lic.includes('cc by-nc-nd')) jtf += 2
  if (has_apc && apc_max.length > 0) jtf += 4
  else if (!has_apc) jtf += 5
  if (has_seal) jtf += 3
  jtf = Math.min(jtf, 25)

  // MQF /25
  let mqf = 8
  if (bib.pissn && bib.eissn) mqf += 3
  else if (bib.pissn || bib.eissn) mqf += 1
  if (reviewArr.length > 0) mqf += 3
  if (has_seal) mqf += 4
  mqf = Math.min(mqf, 25)

  // EGF /20
  let egf = 6
  if (peer) egf += 5
  if (bib.editorial?.board_url) egf += 4
  if (has_seal) egf += 4
  egf = Math.min(egf, 20)

  // TDF /15
  let tdf = 5
  tdf = Math.min(tdf, 15)  // no Crossref/OpenAlex data at this stage

  // CVF /10
  let cvf = 3
  if (has_seal) cvf += 2
  cvf = Math.min(cvf, 10)

  // RIF /5
  let rif = 2
  if (peer) rif += 1
  if (has_seal) rif += 2
  rif = Math.min(rif, 5)

  const total = jtf + mqf + egf + tdf + cvf + rif
  return { jtf, mqf, egf, tdf, cvf, rif, total, grade: pqfGrade(total) }
}

// ── Build journal object from DOAJ bibjson ───────────────────────────────────

export function buildFromDoaj(bib, item) {
  const issn_print  = bib.pissn ?? null
  const issn_online = bib.eissn ?? null
  // v4: review_processes (plural); v3 compat: review_process
  const reviewArr = bib.editorial?.review_processes ?? bib.editorial?.review_process ?? []
  const peerType  = (Array.isArray(reviewArr) ? reviewArr[0] : reviewArr) ?? 'Peer review'
  const lang      = languageName(bib.language) ?? 'English'
  const countryCode    = bib.publisher?.country ?? null
  const countryName    = isoToCountry(countryCode)
  const pubTimeWeeks   = bib.publication_time_weeks ?? null
  const admin          = item.admin ?? {}
  const subjects       = (bib.subject ?? [])
    .map(s => s.term)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)  // deduplicate

  // Use ISSN as code for uniqueness at scale; fall back to slugified title
  const primaryIssn = issn_online ?? issn_print ?? null
  const code = primaryIssn ? `issn-${primaryIssn}` : slugify(bib.title ?? '').slice(0, 24)

  // Compute auto_pqf inline — avoids a separate scoring pass
  const scores = scoreDoaj(bib, admin)

  return {
    code,
    title: bib.title ?? 'Unknown',
    short_title: (bib.title ?? 'Unknown').split(':')[0].trim(),
    issn_print,
    issn_online,
    publisher: bib.publisher?.name ?? '',
    country: countryName,
    registration_country: countryName || null,
    language: lang,
    frequency: weeksToFrequency(pubTimeWeeks),
    peer_review_type: peerType,
    license: licenseLabel(bib) ?? 'Open Access',
    website_url: bib.ref?.journal ?? '',
    oai_base_url: null,
    doaj_status: 'listed',   // DOAJ search only returns listed journals
    subjects: subjects.length ? subjects : null,
    article_count: 0,
    _scores: scores,         // used by buildRecord; not stored as-is
  }
}

// ── Output formatter ────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10)

/**
 * Build a Discovered journal record (the shape stored in
 * src/lib/discovered-journals.json). All required Journal fields get safe
 * non-null defaults.
 */
export function buildRecord(j) {
  const code = recordCode(j)
  const record = {
    id: `j-disc-${code}`,
    journal_code: code,
    title: j.title ?? '',
    short_title: j.short_title ?? j.title?.split(':')[0]?.trim() ?? '',
    issn_print: j.issn_print ?? null,
    issn_online: j.issn_online ?? null,
    publisher: j.publisher ?? '',
    country: j.country ?? '',
    language: j.language ?? 'English',
    frequency: j.frequency ?? '',
    open_access: true,
    license: j.license ?? 'Open Access',
    peer_review_type: j.peer_review_type ?? 'Peer review',
    website_url: j.website_url ?? '',
    oai_base_url: j.oai_base_url ?? null,
    registration_country: j.registration_country ?? null,
    doaj_status: j.doaj_status ?? 'not_listed',
    openalex_source_id: null,
    metadata_quality_score: 30,
    transparency_score: 30,
    indexing_readiness: 'D',
    pqf: null,
  }
  if (j._scores) record.auto_pqf = autoPqf(j._scores)
  record.subjects = j.subjects?.length ? j.subjects : null
  record.article_count = j.article_count ?? 0
  record.created_at = `${TODAY}T00:00:00Z`
  record.updated_at = `${TODAY}T00:00:00Z`
  return record
}