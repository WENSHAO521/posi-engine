// The compact OpenAlex journal profile the journal pages read, shared by the snapshot harvest
// (monthly, harvest-openalex-snapshot.mjs) and the daily API refresh (harvest-openalex-profiles.mjs).

/** Compact journal profile. Short keys: 158k of these are served as static shards. */
export function profileOf(s) {
  const st = s.summary_stats ?? {}
  const years = (s.counts_by_year ?? []).map(c => [c.year, c.works_count ?? 0, c.cited_by_count ?? 0]).sort((a, b) => a[0] - b[0])
  const topics = (s.topics ?? []).slice(0, 6).map(t => [t.display_name, t.subfield?.display_name ?? null, t.field?.display_name ?? null, t.count ?? 0])
  const p = {
    id: String(s.id).replace('https://openalex.org/', ''),
    t: s.display_name,
    ab: s.abbreviated_title || undefined,
    alt: (s.alternate_titles ?? []).filter(x => x && x !== s.display_name).slice(0, 4),
    hp: s.homepage_url || undefined,
    apc: s.apc_usd ?? undefined,
    cc: s.country_code || undefined,
    pub: s.host_organization_name || undefined,
    w: s.works_count ?? 0,
    c: s.cited_by_count ?? 0,
    h: st.h_index ?? undefined,
    i10: st.i10_index ?? undefined,
    y0: s.first_publication_year ?? undefined,
    y1: s.last_publication_year ?? undefined,
    cy: years,
    tp: topics,
    soc: (s.societies ?? []).map(x => x.organization).filter(Boolean).slice(0, 3),
  }
  if (!p.alt.length) delete p.alt
  if (!p.soc.length) delete p.soc
  return p
}
