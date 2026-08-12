/**
 * Scoring dimensions shared verbatim between AJR-E (ajr-early-stage.mjs)
 * and AJR-M (ajr-mature.mjs) — the framework is explicit that AJR-M's
 * Transparency & Access Policy dimension uses "same criteria as AJR-E
 * dimension 7." Living in one module means the two rubrics can never
 * silently drift apart on a dimension that's supposed to be identical.
 *
 * Built on evidence-coverage.mjs's dimensionScore() so this dimension
 * automatically gets the framework's Evidence Coverage normalization
 * (Met/Not Met/Unknown/Blocked/Not Applicable/Conflicted/Stale, never a
 * binary found/not-found) for free, rather than reimplementing ad hoc
 * boolean scoring the way AJR v0.3/AJR-E-1.0's original scoreTransparency
 * did.
 */

import { dimensionScore } from './evidence-coverage.mjs'

export const TRANSPARENCY_DIMENSION_WEIGHT = 10

/**
 * Transparency & Access Policy (10 points) — never rewards "must be open
 * access"; any access model is fine, the requirement is DISCLOSURE.
 * Item ids and weights match the framework verbatim:
 *   APC/subscription/publication-fee disclosure (2)
 *   Copyright & licensing (2)
 *   Access model disclosure (1)
 *   Publisher ownership/contact (2)
 *   Author guidelines (1)
 *   Advertising/sponsorship disclosure (1)
 *   Other applicable terms (1)
 * Total = 10.
 */
export const TRANSPARENCY_ITEMS = Object.freeze([
  { id: 'fee_disclosure', weight: 2, label: 'APC/subscription/publication-fee disclosure' },
  { id: 'copyright_licensing', weight: 2, label: 'Copyright & licensing' },
  { id: 'access_model_disclosure', weight: 1, label: 'Access model disclosure' },
  { id: 'publisher_ownership_contact', weight: 2, label: 'Publisher ownership/contact' },
  { id: 'author_guidelines', weight: 1, label: 'Author guidelines' },
  { id: 'advertising_sponsorship_disclosure', weight: 1, label: 'Advertising/sponsorship disclosure' },
  { id: 'other_applicable_terms', weight: 1, label: 'Other applicable terms' },
])

/**
 * @param {Object<string, 'met'|'not_met'|'unknown'|'blocked'|'not_applicable'|'conflicted'|'stale'>} itemStatuses
 *   - keyed by TRANSPARENCY_ITEMS[].id. An item id not present in this
 *   object defaults to 'unknown' (evidence simply not yet gathered),
 *   never treated as failing.
 * @returns {{ score: number, coverage: object, items: object[] }}
 */
export function scoreTransparency(itemStatuses = {}) {
  const items = TRANSPARENCY_ITEMS.map(spec => ({
    id: spec.id,
    weight: spec.weight,
    status: itemStatuses[spec.id] ?? 'unknown',
  }))
  const result = dimensionScore(items, TRANSPARENCY_DIMENSION_WEIGHT)
  return { ...result, items }
}
