/**
 * PSC classification — implements posi-data/PSC-CROSSWALK.md.
 *
 * Pure functions: given an OpenAlex source's `topics` array (already
 * fetched by the caller — this module does no I/O), map through the
 * OpenAlex-field-to-PSC crosswalk and return a category + confidence.
 *
 * This supersedes the original stub's design (a free-text
 * `{ topic, share }[]` distribution mapped by string-matching against a
 * loaded taxonomy, requiring mandatory human confirmation before being
 * applied). That approach was never implemented because POSI didn't yet
 * have journal-level topic data to design a real mapping against. Once it
 * did (OpenAlex's own field/subfield/domain structure per source, fetched
 * via the free singleton lookup), the natural crosswalk target became
 * OpenAlex's fixed ~26-field taxonomy directly, not a generic topic string.
 *
 * Human confirmation is not a hard gate here — instead, `confidence` is the
 * signal that downstream consumers (ranking/cohort code) must treat as
 * non-authoritative below `high`. This is deliberately weaker than the
 * original stub's "never auto-applied without a Subject Editor" design;
 * see PSC-CROSSWALK.md § 5 — only `high` (or a human-`verified`
 * classification, which this module never produces itself — see
 * cohort.mjs) should ever be used for cohort/quartile membership. A
 * human-review workflow for `medium`/`low`-confidence or disputed
 * classifications remains a valid future addition (POSI's
 * evidence-correction/appeals principle applies here the same as anywhere
 * else) but is not required for a classification to exist at all, the way
 * the original stub specified.
 *
 * PSC-CROSSWALK-0.2 (POSI Journal Evaluation & Ranking Framework 1.0):
 * expands `psc_confidence` from a binary `high`/`low` to four states —
 * `high`, `medium`, `low`, `unclassified` — per the framework's explicit
 * requirement that "only `high` (or `verified`) may enter a peer cohort"
 * and that a `low`/`medium`/`unclassified` guess may still DISPLAY but
 * must never rank. The `high` bar itself (both gates below) is UNCHANGED
 * from PSC-CROSSWALK.md v0.1/PSC-CROSSWALK-0.1 — this is additive
 * granularity below that bar, not a redefinition of what "high" means, so
 * every journal previously classified `high` stays `high`.
 *
 * Judgment call (flagged per the task's own instructions, since the
 * framework doesn't specify the medium/low split precisely): `medium` is
 * reserved for "the category genuinely IS concentrated (clears the same
 * 15% share bar as `high`) but on a thinner sample than the full 50-works
 * bar (>=20 works)" — i.e. a real signal on less evidence. A large sample
 * with NO real concentration (e.g. 10 PSC categories at an even ~10%
 * share each) stays `low`, not `medium` — lack of concentration is
 * disqualifying on its own regardless of sample size, matching
 * PSC-CROSSWALK.md § 4's treatment of genuine generalist mega-journals
 * (Nature/Science/The Lancet) as `low`, never a partial-confidence tier.
 * `unclassified` replaces the old `{ psc_category: null, psc_confidence:
 * null }` case (no topics at all, or no topic maps to any PSC code) with
 * an explicit, named state rather than a null sentinel.
 */

export const PSC_CROSSWALK_VERSION = 'PSC-CROSSWALK-0.2'

/** Below this share of total topic-count mass, the winning PSC category
 * doesn't dominate clearly enough to trust at the `high` tier. */
export const CONFIDENCE_SHARE_THRESHOLD = 0.15
/** Below this many OpenAlex-indexed works, even a dominant share is
 * unreliable at the `high` tier — see PSC-CROSSWALK.md § 3 for the real
 * misclassification (a 41-work journal, confidently but wrongly
 * classified) that showed a share-only gate isn't sufficient on its own. */
export const MIN_WORKS_COUNT = 50
/** `medium` tier: the concentration gate is fully met (same
 * CONFIDENCE_SHARE_THRESHOLD as `high`) but the sample is thinner than the
 * `high` bar — this is the minimum sample size below which even a fully
 * dominant share is discarded as noise (matches the "one or two
 * dance-studies articles" order of magnitude that motivated MIN_WORKS_COUNT
 * in the first place; below this, don't even offer `medium`). */
export const MEDIUM_MIN_WORKS_COUNT = 20

/** Confidence states that may be used to build an E-Q/M-Q/Citation-Q peer
 * cohort (see cohort.mjs). `verified` is a human-confirmed classification
 * (POSI Subject Editor sign-off) — this module never assigns it itself. */
export const RANK_ELIGIBLE_PSC_CONFIDENCE = new Set(['high', 'verified'])

/** @param {string|null|undefined} confidence
 * @returns {boolean} whether this confidence level may enter a peer cohort
 *   for E-Q/M-Q/Citation-Q ranking (framework: "Only `high` (or `verified`)
 *   may enter a peer cohort"). `medium`/`low`/`unclassified` may still be
 *   displayed as a suggested category, just never used for ranking. */
export function isRankEligiblePscConfidence(confidence) {
  return RANK_ELIGIBLE_PSC_CONFIDENCE.has(confidence)
}

// OpenAlex field -> PSC code, for fields that land in one PSC category
// unambiguously.
export const FIELD_TO_PSC = {
  'Mathematics': 'P1.01',
  'Computer Science': 'P1.02',
  'Physics and Astronomy': 'P1.03',
  'Chemistry': 'P1.04',
  'Earth and Planetary Sciences': 'P1.05',
  'Environmental Science': 'P1.05',
  'Biochemistry, Genetics and Molecular Biology': 'P1.06',
  'Agricultural and Biological Sciences': 'P1.06',
  'Immunology and Microbiology': 'P1.06',
  'Neuroscience': 'P3.01',
  'Chemical Engineering': 'P2.04',
  'Materials Science': 'P2.05',
  'Energy': 'P2.11',
  'Engineering': 'P2.11',
  'Medicine': 'P3.02',
  'Health Professions': 'P3.03',
  'Nursing': 'P3.03',
  'Dentistry': 'P3.02',
  'Pharmacology, Toxicology and Pharmaceutics': 'P3.01',
  'Veterinary Science': 'P4.03',
  'Psychology': 'P5.01',
  'Business, Management and Accounting': 'P5.02',
  'Economics, Econometrics and Finance': 'P5.02',
  'Decision Sciences': 'P5.02',
  'Social Sciences': 'P5.09',
  'Arts and Humanities': 'P6.05',
}

// Subfield-level overrides, checked before FIELD_TO_PSC, for OpenAlex
// fields too broad to map to one PSC category reliably (Engineering,
// Social Sciences, Arts and Humanities, Agricultural and Biological
// Sciences).
export const SUBFIELD_OVERRIDES = {
  'Sociology and Political Science': 'P5.04',
  'Political Science and International Relations': 'P5.06',
  'Education': 'P5.03',
  'Law': 'P5.05',
  'Geography, Planning and Development': 'P5.07',
  'Communication': 'P5.08',
  'Transportation': 'P2.01',
  'History': 'P6.01',
  'Archeology (arts and humanities)': 'P6.01',
  'Language and Linguistics': 'P6.02',
  'Literature and Literary Theory': 'P6.02',
  'Linguistics and Language': 'P6.02',
  'Philosophy': 'P6.03',
  'Religious studies': 'P6.03',
  'Visual Arts and Performing Arts': 'P6.04',
  'Music': 'P6.04',
  'Civil and Structural Engineering': 'P2.01',
  'Electrical and Electronic Engineering': 'P2.02',
  'Mechanical Engineering': 'P2.03',
  'Aerospace Engineering': 'P2.03',
  'Automotive Engineering': 'P2.03',
  'Building and Construction': 'P2.01',
  'Plant Science': 'P4.01',
  'Animal Science and Zoology': 'P4.02',
  'Food Science': 'P4.01',
  'Insect Science': 'P4.01',
  'Aquatic Science': 'P4.01',
  'Forestry': 'P4.01',
}

/**
 * @param {string|null} field - OpenAlex topic.field.display_name
 * @param {string|null} subfield - OpenAlex topic.subfield.display_name
 * @returns {string|null} a PSC code, or null if neither table matches
 */
export function mapToPsc(field, subfield) {
  if (subfield && SUBFIELD_OVERRIDES[subfield]) return SUBFIELD_OVERRIDES[subfield]
  if (field && FIELD_TO_PSC[field]) return FIELD_TO_PSC[field]
  return null
}

/**
 * @param {{ count: number, field?: { display_name: string }, subfield?: { display_name: string } }[]} topics
 *   - a source's `topics` array from OpenAlex (GET /sources/issn:{issn}), unmodified
 * @param {number} worksCount - the source's works_count from the same OpenAlex record
 * @returns {{ psc_category: string|null, psc_confidence: 'high'|'medium'|'low'|'unclassified' }}
 */
export function classifyPsc(topics, worksCount) {
  if (!topics || topics.length === 0) return { psc_category: null, psc_confidence: 'unclassified' }
  const total = topics.reduce((s, t) => s + (t.count ?? 0), 0)
  if (total === 0) return { psc_category: null, psc_confidence: 'unclassified' }

  // Aggregate by mapped PSC category, not just the single top OpenAlex
  // topic — several distinct topics/subfields often map to the same PSC
  // code, so looking only at the top topic's own share understates real
  // concentration.
  const byPsc = new Map()
  for (const t of topics) {
    const psc = mapToPsc(t.field?.display_name, t.subfield?.display_name)
    if (!psc) continue
    byPsc.set(psc, (byPsc.get(psc) ?? 0) + (t.count ?? 0))
  }
  if (byPsc.size === 0) return { psc_category: null, psc_confidence: 'unclassified' }

  const [winningPsc, winningCount] = [...byPsc.entries()].sort((a, b) => b[1] - a[1])[0]
  const share = winningCount / total
  const works = worksCount ?? 0
  const shareMeetsHighBar = share >= CONFIDENCE_SHARE_THRESHOLD

  let confidence
  if (shareMeetsHighBar && works >= MIN_WORKS_COUNT) {
    confidence = 'high'
  } else if (shareMeetsHighBar && works >= MEDIUM_MIN_WORKS_COUNT) {
    // Concentration gate fully met, sample thinner than the `high` bar —
    // see module header for why this is `medium`, not `low`.
    confidence = 'medium'
  } else {
    confidence = 'low'
  }
  return { psc_category: winningPsc, psc_confidence: confidence }
}
