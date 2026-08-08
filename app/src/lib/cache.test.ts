import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineCache } from './cache.ts'

// Each cache needs its own name: defineCache stores entries on globalThis, so
// two caches sharing a name in one process would share entries.
let n = 0
const uniq = () => `test-${n++}`

test('serves from cache within the TTL, reloads after it', async () => {
  let calls = 0
  const c = defineCache(uniq(), 50, async () => ++calls)

  assert.equal(await c.get(), 1)
  assert.equal(await c.get(), 1, 'second read inside the TTL must not reload')
  assert.equal(calls, 1)

  await new Promise((r) => setTimeout(r, 60))
  assert.equal(await c.get(), 2, 'read after the TTL reloads')
})

test('coalesces concurrent misses into one upstream call', async () => {
  let calls = 0
  const c = defineCache(uniq(), 1000, async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return 'v'
  })

  const all = await Promise.all([c.get(), c.get(), c.get(), c.get()])
  assert.deepEqual(all, ['v', 'v', 'v', 'v'])
  assert.equal(calls, 1, 'four concurrent readers, one upstream call')
})

test('keys entries separately', async () => {
  const c = defineCache(uniq(), 1000, async (key) => `loaded:${key}`)
  assert.equal(await c.get('a'), 'loaded:a')
  assert.equal(await c.get('b'), 'loaded:b')
  assert.equal(c.peek('a'), 'loaded:a')
})

test('without serveStaleOnError, a failed refresh propagates', async () => {
  let fail = false
  const c = defineCache(uniq(), 1, async () => {
    if (fail) throw new Error('upstream down')
    return 'good'
  })

  assert.equal(await c.get(), 'good')
  fail = true
  await new Promise((r) => setTimeout(r, 10))
  await assert.rejects(() => c.get(), /upstream down/)
})

test('with serveStaleOnError, a failed refresh serves the last good value', async () => {
  let fail = false
  const c = defineCache(uniq(), 1, async () => {
    if (fail) throw new Error('upstream down')
    return 'good'
  }, { serveStaleOnError: true })

  assert.equal(await c.get(), 'good')
  fail = true
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(await c.get(), 'good', 'stale value served instead of throwing')
})

test('serveStaleOnError still throws when nothing was ever cached', async () => {
  const c = defineCache(uniq(), 1000, async () => {
    throw new Error('cold and down')
  }, { serveStaleOnError: true })

  await assert.rejects(() => c.get(), /cold and down/)
})

test('a failed load does not wedge the cache', async () => {
  let fail = true
  const c = defineCache(uniq(), 1000, async () => {
    if (fail) throw new Error('nope')
    return 'ok'
  })

  await assert.rejects(() => c.get(), /nope/)
  fail = false
  // The inflight promise must have been cleared, or this would return the
  // rejected one forever.
  assert.equal(await c.get(), 'ok')
})

test('set() seeds a value without an upstream call', async () => {
  let calls = 0
  const c = defineCache(uniq(), 1000, async () => {
    calls++
    return 'loaded'
  })

  c.set('seeded')
  assert.equal(await c.get(), 'seeded')
  assert.equal(calls, 0)
})

test('peek() never loads', () => {
  const c = defineCache(uniq(), 1000, async () => 'loaded')
  assert.equal(c.peek(), undefined)
})
