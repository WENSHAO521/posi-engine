/**
 * Minimal but RFC4180-correct CSV parser: handles quoted fields containing
 * commas, embedded newlines, and doubled-quote escapes ("" -> "), and
 * strips a leading UTF-8 BOM (several ShowJCR files ship with one). Pure
 * function, no I/O — the caller owns fetching the CSV text.
 *
 * Used only to *parse* ShowJCR's CSVs structurally. It has no opinion on
 * which columns are safe to keep — that decision lives in extract.mjs,
 * right next to the copyright reasoning for each family. Nothing here
 * should be used to persist a full parsed row to disk.
 */

/** @returns {{ header: string[], rows: Record<string, string>[] }} */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text // strip BOM
  const table = parseRows(src)
  if (table.length === 0) return { header: [], rows: [] }
  const [header, ...dataRows] = table
  const rows = dataRows
    .filter(r => !(r.length === 1 && r[0] === '')) // trailing blank line
    .map(r => {
      const obj = {}
      header.forEach((h, i) => { obj[h] = r[i] ?? '' })
      return obj
    })
  return { header, rows }
}

/** @returns {string[][]} */
function parseRows(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue } // normalize CRLF -> LF
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c
    i++
  }
  // last field/row (files not ending in a trailing newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }

  return rows
}
