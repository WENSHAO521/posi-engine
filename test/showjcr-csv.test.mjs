import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/showjcr/csv.mjs'

test('parseCsv splits a simple header + rows', () => {
  const { header, rows } = parseCsv('Journal,ISSN,EISSN\nNature,0028-0836,1476-4687\n')
  assert.deepEqual(header, ['Journal', 'ISSN', 'EISSN'])
  assert.deepEqual(rows, [{ Journal: 'Nature', ISSN: '0028-0836', EISSN: '1476-4687' }])
})

test('parseCsv handles a quoted field containing a comma (real JCR category shape)', () => {
  const csv = 'Journal,ISSN,EISSN,Category\nLANCET,0140-6736,1474-547X,"MEDICINE, GENERAL & INTERNAL"\n'
  const { rows } = parseCsv(csv)
  assert.equal(rows[0].Category, 'MEDICINE, GENERAL & INTERNAL')
})

test('parseCsv handles doubled-quote escapes inside a quoted field', () => {
  const csv = 'Journal,Note\n"Journal of ""Things""",ok\n'
  const { rows } = parseCsv(csv)
  assert.equal(rows[0].Journal, 'Journal of "Things"')
})

test('parseCsv handles an embedded newline inside a quoted field', () => {
  const csv = 'Journal,Note\n"Multi\nLine",ok\n'
  const { rows } = parseCsv(csv)
  assert.equal(rows[0].Journal, 'Multi\nLine')
  assert.equal(rows[0].Note, 'ok')
})

test('parseCsv strips a leading UTF-8 BOM', () => {
  const { header } = parseCsv('﻿Journal,ISSN\nX,0000-0000\n')
  assert.deepEqual(header, ['Journal', 'ISSN'])
})

test('parseCsv normalizes CRLF line endings', () => {
  const { rows } = parseCsv('Journal,ISSN\r\nX,0000-0000\r\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ISSN, '0000-0000')
})

test('parseCsv tolerates a file with no trailing newline', () => {
  const { rows } = parseCsv('Journal,ISSN\nX,0000-0000')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].Journal, 'X')
})

test('parseCsv on an empty string returns no header and no rows', () => {
  assert.deepEqual(parseCsv(''), { header: [], rows: [] })
})
