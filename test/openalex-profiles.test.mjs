import { test } from 'node:test'
import assert from 'node:assert/strict'
import { profileOf } from '../scripts/global/profile.mjs'
import { PROFILE_SELECT, pageUrl } from '../scripts/global/harvest-openalex-profiles.mjs'

test('the API refresh selects every field the journal profile reads', () => {
  const fields = new Set(PROFILE_SELECT.split(','))
  const read = ['id', 'display_name', 'abbreviated_title', 'alternate_titles', 'homepage_url', 'apc_usd', 'country_code',
    'host_organization_name', 'works_count', 'cited_by_count', 'summary_stats', 'first_publication_year',
    'last_publication_year', 'counts_by_year', 'topics', 'societies']
  for (const f of read) assert.ok(fields.has(f), f)
  const u = new URL(pageUrl('*'))
  // every source type: a POSI journal can sit on a source OpenAlex types as a conference or book series
  assert.equal(u.searchParams.get('filter'), null)
  assert.equal(u.searchParams.get('cursor'), '*')
})

test('an API source maps to the same compact profile as a snapshot line', () => {
  const p = profileOf({
    id: 'https://openalex.org/S123', display_name: 'AI & Future Society', works_count: 14, cited_by_count: 20,
    summary_stats: { h_index: 3, i10_index: 1 }, first_publication_year: 2025, last_publication_year: 2026,
    counts_by_year: [{ year: 2026, works_count: 9, cited_by_count: 10 }, { year: 2025, works_count: 5, cited_by_count: 10 }],
  })
  assert.equal(p.id, 'S123')
  assert.deepEqual([p.w, p.c, p.h, p.i10], [14, 20, 3, 1])
  assert.deepEqual(p.cy, [[2025, 5, 10], [2026, 9, 10]])
})
