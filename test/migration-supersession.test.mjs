import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSupersessionRows,
  buildSupersessionMap,
  resolveSupersededId,
  applySupersessionForwarding,
  buildForwardedValueIndex,
} from '../src/migration/supersession.mjs'

test('validateSupersessionRows accepts a clean flat set of rows', () => {
  const rows = [
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000003', superseded_by_posi_id: 'POSI-J-000004' },
  ]
  const { valid, errors } = validateSupersessionRows(rows)
  assert.equal(valid, true)
  assert.deepEqual(errors, [])
})

test('validateSupersessionRows rejects self-supersession', () => {
  const rows = [{ old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000001' }]
  const { valid, errors } = validateSupersessionRows(rows)
  assert.equal(valid, false)
  assert.ok(errors.some(e => e.includes('self-supersession')))
})

test('validateSupersessionRows rejects a duplicate old_posi_id', () => {
  const rows = [
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000003' },
  ]
  const { valid, errors } = validateSupersessionRows(rows)
  assert.equal(valid, false)
  assert.ok(errors.some(e => e.includes('duplicate old_posi_id')))
})

test('validateSupersessionRows rejects a 2-hop chain (A -> B -> C)', () => {
  const rows = [
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000002', superseded_by_posi_id: 'POSI-J-000003' },
  ]
  const { valid, errors } = validateSupersessionRows(rows)
  assert.equal(valid, false)
  assert.ok(errors.some(e => e.includes('chain detected')))
})

test('validateSupersessionRows rejects a direct A <-> B cycle', () => {
  const rows = [
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000002', superseded_by_posi_id: 'POSI-J-000001' },
  ]
  const { valid, errors } = validateSupersessionRows(rows)
  assert.equal(valid, false)
  // A cycle between two rows is also a chain (each is the other's target and source)
  assert.ok(errors.length > 0)
})

test('validateSupersessionRows checks superseded_by_posi_id actually exists when knownPosiIds is given', () => {
  const rows = [{ old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-999999' }]
  const { valid, errors } = validateSupersessionRows(rows, { knownPosiIds: new Set(['POSI-J-000001']) })
  assert.equal(valid, false)
  assert.ok(errors.some(e => e.includes('does not exist')))
})

test('resolveSupersededId returns the id unchanged when it was never superseded', () => {
  const map = buildSupersessionMap([{ old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' }])
  assert.equal(resolveSupersededId('POSI-J-999999', map), 'POSI-J-999999')
})

test('resolveSupersededId follows a single-hop supersession to the surviving id', () => {
  const map = buildSupersessionMap([{ old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' }])
  assert.equal(resolveSupersededId('POSI-J-000001', map), 'POSI-J-000002')
})

test('resolveSupersededId defensively follows a multi-hop chain even though validation forbids writing one', () => {
  const map = buildSupersessionMap([
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000002', superseded_by_posi_id: 'POSI-J-000003' },
  ])
  assert.equal(resolveSupersededId('POSI-J-000001', map), 'POSI-J-000003')
})

test('resolveSupersededId throws on a cycle rather than looping forever', () => {
  const map = buildSupersessionMap([
    { old_posi_id: 'POSI-J-000001', superseded_by_posi_id: 'POSI-J-000002' },
    { old_posi_id: 'POSI-J-000002', superseded_by_posi_id: 'POSI-J-000001' },
  ])
  assert.throws(() => resolveSupersededId('POSI-J-000001', map), /Cycle detected/)
})

test('applySupersessionForwarding rewrites a value index so an old identity value resolves straight to the surviving id', () => {
  const valueIndex = new Map([
    ['issn_l:0099-5355', 'POSI-J-023333'], // old ISSN, resolves to the old (now superseded) id
    ['issn_l:0140-6736', 'POSI-J-025606'], // new/current ISSN, already correct
  ])
  const supersessionMap = buildSupersessionMap([{ old_posi_id: 'POSI-J-023333', superseded_by_posi_id: 'POSI-J-025606' }])
  const forwarded = applySupersessionForwarding(valueIndex, supersessionMap)
  assert.equal(forwarded.get('issn_l:0099-5355'), 'POSI-J-025606', 'old ISSN now resolves to the surviving id, not the retired one')
  assert.equal(forwarded.get('issn_l:0140-6736'), 'POSI-J-025606', 'already-current entry is unaffected')
})

test('applySupersessionForwarding is a no-op (and does not mutate the input) when there is nothing to supersede', () => {
  const valueIndex = new Map([['issn_l:1111-1111', 'POSI-J-000001']])
  const forwarded = applySupersessionForwarding(valueIndex, new Map())
  assert.equal(forwarded, valueIndex, 'returns the same map instance when the supersession map is empty')
})

test('buildForwardedValueIndex: the exact resolver flow -- resolve(old ISSN) -> old posi_id -> follow superseded_by -> surviving posi_id', () => {
  // The Lancet's real supersession case: the registry still has a
  // permanent row for the old, wrong ISSN pointing at the retired id --
  // that row is never deleted (registry is append-only). A resolver that
  // used the raw registry rows unforwarded would return the retired id.
  const registryRows = [
    { posi_id: 'POSI-J-023333', identity_type: 'issn_l', identity_value: '0099-5355' }, // old, retired
    { posi_id: 'POSI-J-025606', identity_type: 'issn_l', identity_value: '0140-6736' }, // current, surviving
  ]
  const supersessionMap = buildSupersessionMap([
    { old_posi_id: 'POSI-J-023333', superseded_by_posi_id: 'POSI-J-025606' },
  ])

  const idx = buildForwardedValueIndex(registryRows, supersessionMap)

  // A future ingest that encounters the OLD ISSN again must resolve to
  // the SURVIVING id, not silently revive the retired one.
  assert.equal(idx.get('0099-5355')[0].posi_id, 'POSI-J-025606', 'old ISSN follows through to the surviving id, not the retired one')
  // The current ISSN is unaffected either way.
  assert.equal(idx.get('0140-6736')[0].posi_id, 'POSI-J-025606')
})

test('buildForwardedValueIndex leaves non-superseded values completely unaffected', () => {
  const registryRows = [{ posi_id: 'POSI-J-000001', identity_type: 'issn_l', identity_value: '1111-1111' }]
  const idx = buildForwardedValueIndex(registryRows, new Map())
  assert.equal(idx.get('1111-1111')[0].posi_id, 'POSI-J-000001')
})
