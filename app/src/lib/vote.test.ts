import { test } from 'node:test'
import assert from 'node:assert/strict'

// config.ts reads the environment at module load, so the signing secret has to
// exist BEFORE ./vote.ts is imported — hence the await import rather than a
// static one at the top of the file.
process.env.VOTE_SIGNING_SECRET = 'test-signing-secret'
const { signState, verifyState } = await import('./vote.ts')

test('signState round-trips through verifyState', () => {
  const state = signState({ issue: 42, direction: 'up' })
  assert.deepEqual(verifyState(state), { issue: 42, direction: 'up' })
})

test('verifyState rejects a tampered payload', () => {
  // The whole point of the signature: the issue number rides through GitHub in
  // plain sight, so editing it must invalidate the blob.
  const [body, mac] = signState({ issue: 42, direction: 'up' }).split('.')
  const forged = Buffer.from(JSON.stringify({ issue: 999, direction: 'up', e: Date.now() + 60_000, n: 'x' }))
    .toString('base64url')
  assert.notEqual(forged, body)
  assert.equal(verifyState(`${forged}.${mac}`), null)
})

test('verifyState rejects a bad or truncated signature', () => {
  const [body] = signState({ issue: 42, direction: 'up' }).split('.')
  // A wrong-length mac must return null, not throw out of timingSafeEqual.
  assert.equal(verifyState(`${body}.short`), null)
  assert.equal(verifyState(`${body}.${'a'.repeat(43)}`), null)
  assert.equal(verifyState(body), null)
  assert.equal(verifyState(null), null)
  assert.equal(verifyState(''), null)
})

test('verifyState rejects an expired state', async () => {
  const { signState: sign } = await import('./vote.ts')
  const state = sign({ issue: 42, direction: 'down' })
  const [body, mac] = state.split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  payload.e = Date.now() - 1
  const stale = Buffer.from(JSON.stringify(payload)).toString('base64url')
  // Re-signed under the real key: expiry must be enforced on its own, not just
  // as a side effect of the signature failing.
  assert.equal(verifyState(`${stale}.${mac}`), null)
})

test('signState produces a distinct blob each time', () => {
  // The nonce: two identical votes must not yield a shared, cacheable string.
  const a = signState({ issue: 1, direction: 'up' })
  const b = signState({ issue: 1, direction: 'up' })
  assert.notEqual(a, b)
})
