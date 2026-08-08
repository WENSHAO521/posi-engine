/**
 * Field normalization for journal migration records — first stage of the
 * dry-run pipeline. Pure functions only; no I/O.
 */

/** Unicode NFC + whitespace collapse + trim. Returns null for empty/blank input. */
export function normalizeTitle(title) {
  if (title == null) return null
  const t = title.normalize('NFC').replace(/\s+/g, ' ').trim()
  return t.length > 0 ? t : null
}

/**
 * ISSN check-digit validation (ISO 3297 mod-11 algorithm).
 * @param {string} issn - already in XXXX-XXXX shape, last char may be 'X'.
 */
export function issnChecksumValid(issn) {
  const digits = issn.replace('-', '')
  if (!/^\d{7}[\dX]$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 7; i++) sum += Number(digits[i]) * (8 - i)
  const check = (11 - (sum % 11)) % 11
  const checkChar = check === 10 ? 'X' : String(check)
  return digits[7] === checkChar
}

/**
 * @param {string | null} raw
 * @returns {{ value: string | null, valid: boolean, warning: string | null }}
 *   value is the normalized XXXX-XXXX form if the shape is parseable, even
 *   when the checksum fails (so callers can still report *what* was invalid).
 */
export function normalizeIssn(raw) {
  if (raw == null) return { value: null, valid: false, warning: null }
  const cleaned = raw.trim().toUpperCase().replace(/[^0-9X]/g, '')
  if (cleaned.length !== 8) {
    return { value: null, valid: false, warning: `malformed ISSN shape: "${raw}"` }
  }
  const formatted = `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
  const valid = issnChecksumValid(formatted)
  return {
    value: formatted,
    valid,
    warning: valid ? null : `ISSN checksum failed: "${raw}" -> ${formatted}`,
  }
}

/** Lowercase scheme+host, strip trailing slash. Returns null if unparseable. */
export function normalizeUrl(raw) {
  if (raw == null) return null
  try {
    const u = new URL(raw.trim())
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()
    let s = u.toString()
    if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1)
    return s
  } catch {
    return null
  }
}

// Deliberately small and centrally maintained — extend via PR, not silent
// per-record guessing. Anything not in this map is left as-is and flagged
// as a normalization warning rather than silently dropped.
const COUNTRY_NAME_TO_ISO2 = {
  'united states': 'US', 'united states of america': 'US', usa: 'US',
  'united kingdom': 'GB', uk: 'GB',
  germany: 'DE', france: 'FR', canada: 'CA', australia: 'AU',
  china: 'CN', japan: 'JP', 'south korea': 'KR', korea: 'KR',
  india: 'IN', brazil: 'BR', 'russian federation': 'RU', russia: 'RU',
  italy: 'IT', spain: 'ES', netherlands: 'NL', switzerland: 'CH',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI',
  poland: 'PL', turkey: 'TR', mexico: 'MX', indonesia: 'ID',
  'saudi arabia': 'SA', 'south africa': 'ZA', egypt: 'EG', nigeria: 'NG',
  singapore: 'SG', malaysia: 'MY', thailand: 'TH', vietnam: 'VN',
  philippines: 'PH', pakistan: 'PK', bangladesh: 'BD', iran: 'IR',
  israel: 'IL', 'united arab emirates': 'AE', taiwan: 'TW', 'hong kong': 'HK',
  ukraine: 'UA', romania: 'RO', greece: 'GR', portugal: 'PT',
  austria: 'AT', belgium: 'BE', ireland: 'IE', 'czech republic': 'CZ', czechia: 'CZ',
  hungary: 'HU', croatia: 'HR', serbia: 'RS', slovenia: 'SI', slovakia: 'SK',
  bulgaria: 'BG', 'new zealand': 'NZ', colombia: 'CO', argentina: 'AR',
  chile: 'CL', peru: 'PE', 'sri lanka': 'LK', nepal: 'NP', kenya: 'KE',
  morocco: 'MA', algeria: 'DZ', tunisia: 'TN', jordan: 'JO', iraq: 'IQ',
  ecuador: 'EC', venezuela: 'VE', cuba: 'CU', uzbekistan: 'UZ', kazakhstan: 'KZ',
}

/**
 * @param {string | null} raw
 * @returns {{ value: string | null, warning: string | null }}
 *   value is an ISO 3166-1 alpha-2 code, or null if unmapped/unrecognized.
 */
export function normalizeCountry(raw) {
  if (raw == null) return { value: null, warning: null }
  const trimmed = raw.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed)) return { value: trimmed.toUpperCase(), warning: null }
  const mapped = COUNTRY_NAME_TO_ISO2[trimmed.toLowerCase()]
  if (mapped) return { value: mapped, warning: null }
  return { value: null, warning: `unmapped country name: "${raw}"` }
}

/**
 * Normalizes one migration-source.jsonl record. Never throws — accumulates
 * warnings instead, so a single bad record can't abort a 23k-record run.
 * @returns {{ normalized: object, warnings: string[] }}
 */
export function normalizeRecord(record) {
  const warnings = []

  const title = normalizeTitle(record.title)
  if (!title) warnings.push('missing or empty title')

  const issnPrint = normalizeIssn(record.issn_print)
  if (issnPrint.warning) warnings.push(issnPrint.warning)
  const issnOnline = normalizeIssn(record.issn_online)
  if (issnOnline.warning) warnings.push(issnOnline.warning)
  const issnL = normalizeIssn(record.issn_l)
  if (issnL.warning) warnings.push(issnL.warning)

  if (issnPrint.value && issnOnline.value && issnPrint.value === issnOnline.value) {
    warnings.push('issn_print and issn_online are identical — likely a single known ISSN duplicated into both fields, not two distinct ISSNs')
  }

  const website = normalizeUrl(record.website_url)
  if (record.website_url && !website) warnings.push(`unparseable website_url: "${record.website_url}"`)

  const country = normalizeCountry(record.country)
  if (country.warning) warnings.push(country.warning)

  return {
    normalized: {
      source_collection: record.source_collection,
      legacy_id: record.legacy_id,
      title,
      short_title: normalizeTitle(record.short_title),
      issn_print: issnPrint.valid ? issnPrint.value : null,
      issn_online: issnOnline.valid ? issnOnline.value : null,
      issn_l: issnL.valid ? issnL.value : null,
      publisher: normalizeTitle(record.publisher), // same whitespace/unicode rules apply
      country: country.value,
      website_url: website,
      openalex_source_id: record.openalex_source_id ?? null,
      doaj_status: record.doaj_status ?? null,
      doaj_id: record.doaj_id ?? null,
      article_count: Number.isFinite(record.article_count) ? record.article_count : 0,
    },
    warnings,
  }
}
