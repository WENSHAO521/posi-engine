import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stratifiedSample } from '../scripts/sample-corpus.mjs'

const j = (id, host) => ({ posi_id: `POSI-J-${String(id).padStart(6, '0')}`, website_url: host ? `https://${host}/j${id}` : null })

test('stratifiedSample: seats follow host size, every host gets one while seats last', () => {
  const corpus = [
    ...Array.from({ length: 60 }, (_, i) => j(i, 'big.example')),
    ...Array.from({ length: 30 }, (_, i) => j(100 + i, 'mid.example')),
    ...Array.from({ length: 10 }, (_, i) => j(200 + i, `small${i}.example`)),
  ]
  const s = stratifiedSample(corpus, 20)
  assert.equal(s.length, 20)
  const count = h => s.filter(x => x.website_url.includes(h)).length
  assert.ok(count('big.example') >= count('mid.example'))
  assert.ok(count('mid.example') >= 3)
  assert.equal(new Set(s.map(x => x.posi_id)).size, 20)
})

test('stratifiedSample: deterministic, and never more than the corpus', () => {
  const corpus = [j(3, 'a.example'), j(1, 'a.example'), j(2, null)]
  assert.deepEqual(stratifiedSample(corpus, 10).map(x => x.posi_id), stratifiedSample([...corpus].reverse(), 10).map(x => x.posi_id))
  assert.equal(stratifiedSample(corpus, 10).length, 3)
})
