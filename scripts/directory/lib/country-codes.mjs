// Country values arrive from several sources in different shapes: OpenAlex and
// DOAJ give ISO 3166 alpha-2 codes, ISSN / library records give MARC country
// codes (two letters for countries, three for US states, Canadian provinces and
// UK nations), and Crossref member records give a free-text postal address.
// The site renders any two-letter value as ISO (records.ts countryName), so a
// MARC code such as IO (Indonesia) shows up as British Indian Ocean Territory.
// Everything is stored as an English country name; this module does the mapping.

// Two-letter codes that were stored as MARC. Several collide with a different
// ISO country (NE Niger, AG Antigua, BL St Barthelemy, CC Cocos Islands, SZ
// Eswatini, GW Guinea-Bissau, NR Nauru, CK Cook Islands, CI Cote d'Ivoire), so
// the scheme was decided per code from the titles and publishers carrying it.
export const MARC2 = {
  AG: 'Argentina', BL: 'Brazil', BU: 'Bulgaria', CC: 'China', CI: 'Croatia', CK: 'Colombia',
  EM: 'Timor-Leste', GW: 'Germany', II: 'India', IO: 'Indonesia', KO: 'South Korea', LE: 'Lebanon',
  NE: 'Netherlands', NR: 'Nigeria', PO: 'Portugal', RM: 'Romania', SP: 'Spain', SZ: 'Switzerland',
  TS: 'United Arab Emirates', TU: 'Turkey', UN: 'Ukraine', XN: 'North Macedonia', XO: 'Slovakia',
  XV: 'Slovenia',
}

// Two-letter codes that were stored as ISO (checked the same way).
export const ISO2 = {
  BB: 'Barbados', CD: 'Congo - Kinshasa', CR: 'Costa Rica', GM: 'Gambia',
  GP: 'Guadeloupe', GU: 'Guam', HK: 'Hong Kong', KR: 'South Korea', LY: 'Libya', ME: 'Montenegro',
  MU: 'Mauritius', PR: 'Puerto Rico', PS: 'Palestine', TT: 'Trinidad and Tobago',
}

// MARC three-letter codes: xx* and the UK nations / US states / Canadian and
// Australian provinces. Anything ending in U is a US state (xxu = United States).
export const MARC3 = {
  XXK: 'United Kingdom', ENK: 'United Kingdom', STK: 'United Kingdom', WLK: 'United Kingdom', NIK: 'United Kingdom',
  XXU: 'United States', XXC: 'Canada', XXA: 'Australia',
  ABC: 'Canada', BCC: 'Canada', MBC: 'Canada', NBC: 'Canada', NSC: 'Canada', ONC: 'Canada', QUC: 'Canada', SNC: 'Canada',
  XNA: 'Australia', VRA: null, QEA: 'Australia', WEA: 'Australia', XRA: 'Australia', TMA: 'Australia', ACA: 'Australia',
}

/**
 * Stored country value -> English name. Returns the input unchanged when it is
 * already a name, and null for a code that cannot be placed with confidence
 * (the caller keeps the original). Unlisted two-letter codes are not guessed.
 */
export function normalizeCountryCode(raw) {
  if (typeof raw !== 'string') return raw
  const v = raw.trim()
  if (!/^[A-Za-z]{2,3}$/.test(v) || v !== v.toUpperCase()) return raw
  if (v.length === 2) return MARC2[v] ?? ISO2[v] ?? null
  if (v in MARC3) return MARC3[v]
  if (v.endsWith('U')) return 'United States'
  return null
}

// Spellings Crossref member addresses use that are not the stored name.
const ADDRESS_ALIASES = {
  'usa': 'United States', 'u.s.a.': 'United States', 'u.s.a': 'United States', 'us': 'United States',
  'united states of america': 'United States', 'uk': 'United Kingdom', 'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom', 'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom',
  'korea': 'South Korea', 'republic of korea': 'South Korea', 'korea, republic of': 'South Korea',
  'russian federation': 'Russia', 'iran, islamic republic of': 'Iran', 'islamic republic of iran': 'Iran',
  'türkiye': 'Turkey', 'turkiye': 'Turkey', 'viet nam': 'Vietnam', 'czechia': 'Czech Republic',
  "people's republic of china": 'China', 'pr china': 'China', 'p.r. china': 'China',
  'the netherlands': 'Netherlands', 'kingdom of saudi arabia': 'Saudi Arabia', 'ksa': 'Saudi Arabia',
  'uae': 'United Arab Emirates', 'hong kong sar': 'Hong Kong', 'hong kong sar china': 'Hong Kong', 'democratic republic of the congo': 'Congo - Kinshasa', 'dr congo': 'Congo - Kinshasa', 'republic of north macedonia': 'North Macedonia',
}

let knownNames = null
function nameIndex() {
  if (knownNames) return knownNames
  knownNames = new Map()
  const dn = new Intl.DisplayNames(['en'], { type: 'region' })
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const a of L) for (const b of L) {
    try {
      const n = dn.of(a + b)
      if (n && n !== a + b) knownNames.set(n.toLowerCase(), n)
    } catch { /* not a region */ }
  }
  for (const n of [...Object.values(MARC2), ...Object.values(ISO2)]) knownNames.set(n.toLowerCase(), n)
  for (const n of ['Turkey', 'Czech Republic', 'Russia', 'Iran', 'Vietnam', 'Taiwan', 'Palestine']) knownNames.set(n.toLowerCase(), n)
  return knownNames
}

/**
 * Country from a free-text postal address such as a Crossref member's
 * `location` ("Jl. Sudirman 12, Jakarta, Indonesia"). Only the last comma
 * segment (or last two, for names with a comma) is considered and it must be a recognised country name; otherwise null.
 */
export function countryFromAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return null
  const parts = address.split(',').map(p => p.trim().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').toLowerCase())
  // Try the last two segments first for names that contain a comma ("Korea, Republic of").
  for (const k of [parts.slice(-2).join(', '), parts[parts.length - 1]]) {
    const hit = ADDRESS_ALIASES[k] ?? nameIndex().get(k)
    if (hit) return hit
  }
  return null
}

// ISO 3166 alpha-2 -> the English names already used in the data. OpenAlex
// (country_code) and DOAJ (publisher.country) give ISO, never MARC, so this
// table is for them; stored values of unknown origin go through normalizeCountryCode.
const ISO_NAMES = {
  AF:'Afghanistan',AL:'Albania',DZ:'Algeria',AD:'Andorra',AO:'Angola',AR:'Argentina',
  AM:'Armenia',AU:'Australia',AT:'Austria',AZ:'Azerbaijan',BH:'Bahrain',BD:'Bangladesh',
  BY:'Belarus',BE:'Belgium',BJ:'Benin',BT:'Bhutan',BO:'Bolivia',BA:'Bosnia and Herzegovina',
  BW:'Botswana',BR:'Brazil',BN:'Brunei',BG:'Bulgaria',BF:'Burkina Faso',BI:'Burundi',
  KH:'Cambodia',CM:'Cameroon',CA:'Canada',CF:'Central African Republic',TD:'Chad',
  CL:'Chile',CN:'China',CO:'Colombia',CG:'Congo',HR:'Croatia',CU:'Cuba',CY:'Cyprus',
  CZ:'Czech Republic',DK:'Denmark',DO:'Dominican Republic',EC:'Ecuador',EG:'Egypt',
  SV:'El Salvador',EE:'Estonia',ET:'Ethiopia',FI:'Finland',FR:'France',GE:'Georgia',
  DE:'Germany',GH:'Ghana',GR:'Greece',GT:'Guatemala',GN:'Guinea',HT:'Haiti',
  HN:'Honduras',HU:'Hungary',IS:'Iceland',IN:'India',ID:'Indonesia',IR:'Iran',
  IQ:'Iraq',IE:'Ireland',IL:'Israel',IT:'Italy',JM:'Jamaica',JP:'Japan',JO:'Jordan',
  KZ:'Kazakhstan',KE:'Kenya',KW:'Kuwait',KG:'Kyrgyzstan',LA:'Laos',LV:'Latvia',
  LB:'Lebanon',LT:'Lithuania',LU:'Luxembourg',MK:'North Macedonia',MG:'Madagascar',
  MW:'Malawi',MY:'Malaysia',MV:'Maldives',ML:'Mali',MT:'Malta',MR:'Mauritania',
  MX:'Mexico',MD:'Moldova',MN:'Mongolia',MA:'Morocco',MZ:'Mozambique',MM:'Myanmar',
  NA:'Namibia',NP:'Nepal',NL:'Netherlands',NZ:'New Zealand',NI:'Nicaragua',
  NG:'Nigeria',NO:'Norway',OM:'Oman',PK:'Pakistan',PA:'Panama',PY:'Paraguay',
  PE:'Peru',PH:'Philippines',PL:'Poland',PT:'Portugal',QA:'Qatar',RO:'Romania',
  RU:'Russia',RW:'Rwanda',SA:'Saudi Arabia',SN:'Senegal',RS:'Serbia',SL:'Sierra Leone',
  SG:'Singapore',SK:'Slovakia',SI:'Slovenia',SO:'Somalia',ZA:'South Africa',
  SS:'South Sudan',ES:'Spain',LK:'Sri Lanka',SD:'Sudan',SE:'Sweden',CH:'Switzerland',
  SY:'Syria',TW:'Taiwan',TJ:'Tajikistan',TZ:'Tanzania',TH:'Thailand',TN:'Tunisia',
  TR:'Turkey',TM:'Turkmenistan',UG:'Uganda',UA:'Ukraine',AE:'United Arab Emirates',
  GB:'United Kingdom',US:'United States',UY:'Uruguay',UZ:'Uzbekistan',VE:'Venezuela',
  VN:'Vietnam',YE:'Yemen',ZM:'Zambia',ZW:'Zimbabwe',
}

// Intl's wording differs from the stored names for these.
const INTL_OVERRIDES = {
  CD: 'Congo - Kinshasa', HK: 'Hong Kong', MO: 'Macao', KR: 'South Korea', KP: 'North Korea',
  PS: 'Palestine', VA: 'Vatican City',
}

/** ISO alpha-2 code -> English country name ('' for none). An unrecognised code is returned as is. */
export function isoToCountry(code) {
  if (!code) return ''
  const c = String(code).trim().toUpperCase()
  if (ISO_NAMES[c]) return ISO_NAMES[c]
  if (INTL_OVERRIDES[c]) return INTL_OVERRIDES[c]
  if (/^[A-Z]{2}$/.test(c)) {
    try {
      const n = new Intl.DisplayNames(['en'], { type: 'region' }).of(c)
      if (n && n !== c && !/unknown/i.test(n)) return n
    } catch { /* not a region */ }
  }
  return code
}

// ISO 3166 short names in the official long form, as the DOAJ journal CSV
// gives them ("Iran, Islamic Republic of"), mapped to the code.
const ISO_LONG_NAMES = {
  'bolivia, plurinational state of': 'BO', 'brunei darussalam': 'BN', 'cabo verde': 'CV',
  'congo, the democratic republic of the': 'CD', 'congo, democratic republic of the': 'CD',
  "côte d'ivoire": 'CI', "cote d'ivoire": 'CI', 'czechia': 'CZ', 'holy see (vatican city state)': 'VA',
  'iran, islamic republic of': 'IR', "korea, democratic people's republic of": 'KP', 'korea, republic of': 'KR',
  "lao people's democratic republic": 'LA', 'micronesia, federated states of': 'FM', 'moldova, republic of': 'MD',
  'palestine, state of': 'PS', 'russian federation': 'RU', 'syrian arab republic': 'SY',
  'taiwan, province of china': 'TW', 'tanzania, united republic of': 'TZ', 'türkiye': 'TR', 'turkiye': 'TR',
  'venezuela, bolivarian republic of': 'VE', 'viet nam': 'VN', 'virgin islands, british': 'VG',
  'virgin islands, u.s.': 'VI', 'macedonia, the former yugoslav republic of': 'MK', 'swaziland': 'SZ',
}

let nameToIso = null
/**
 * A country name in any common English form -> the name the data uses
 * ("Iran, Islamic Republic of", "Türkiye" -> "Iran", "Turkey"). Codes and
 * names it does not recognise are returned unchanged.
 */
export function canonicalCountryName(name) {
  if (typeof name !== 'string' || !name.trim()) return name
  if (!nameToIso) {
    nameToIso = new Map(Object.entries(ISO_LONG_NAMES))
    const dn = new Intl.DisplayNames(['en'], { type: 'region' })
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (const a of L) for (const b of L) {
      const code = a + b
      const stored = isoToCountry(code)
      if (stored && stored !== code) nameToIso.set(stored.toLowerCase(), code)
      try {
        const n = dn.of(code)
        if (n && n !== code && !nameToIso.has(n.toLowerCase())) nameToIso.set(n.toLowerCase(), code)
      } catch { /* not a region */ }
    }
  }
  const key = name.trim().replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase()
  const code = nameToIso.get(key) ?? nameToIso.get(key.replace(/'/g, '’'))
  return code ? isoToCountry(code) : name
}
