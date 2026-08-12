import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shardFor, journalCorePath, metricPath, rankingPath } from '../src/sharding.mjs'

test('shardFor returns a 2-character lowercase hex string', () => {
  const shard = shardFor('POSI-J-000001')
  assert.match(shard, /^[0-9a-f]{2}$/)
})

test('shardFor is deterministic', () => {
  assert.equal(shardFor('POSI-J-000042'), shardFor('POSI-J-000042'))
})

test('shardFor distributes sequential ids across many shards, not clustered by numeric prefix', () => {
  const shards = new Set()
  for (let i = 1; i <= 500; i++) {
    shards.add(shardFor(`POSI-J-${String(i).padStart(6, '0')}`))
  }
  // 500 sequential ids should land in well over half of the 256 possible
  // shards if the hash is doing its job — a prefix-based scheme would
  // cluster them into a handful of shards instead.
  assert.ok(shards.size > 100, `expected broad shard distribution, got ${shards.size} distinct shards`)
})

test('journalCorePath/metricPath/rankingPath build the exact PJR-SPEC.md § 4 layout', () => {
  const id = 'POSI-J-000123'
  const shard = shardFor(id)
  assert.equal(journalCorePath(id), `journals/core/${shard}/${id}.json`)
  assert.equal(metricPath(id, 2025), `metrics/2025/${shard}/${id}.json`)
  assert.equal(rankingPath(id, 2025), `rankings/2025/${shard}/${id}.json`)
})
