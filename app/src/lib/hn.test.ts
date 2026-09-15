import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
// .ts extension: `node --test` runs this file directly (type stripping).
import { fetchHnItem } from './hn.ts'

test('fetchHnItem returns parsed item on success', async () => {
  mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ id: 1, title: 'hello', score: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )

  const item = await fetchHnItem(1)
  assert.notEqual(item, null)
  assert.equal(item!.id, 1)
  assert.equal(item!.title, 'hello')
  assert.equal(item!.score, 42)
})

test('fetchHnItem returns null on non-ok response', async () => {
  mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response(null, { status: 404 }))
  )

  assert.equal(await fetchHnItem(1), null)
})

test('fetchHnItem returns null on network error', async () => {
  mock.method(globalThis, 'fetch', () => Promise.reject(new Error('network')))

  assert.equal(await fetchHnItem(1), null)
})

test('fetchHnItem returns null on null body', async () => {
  mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )

  assert.equal(await fetchHnItem(1), null)
})
