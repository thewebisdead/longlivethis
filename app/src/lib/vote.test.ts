import { test } from 'node:test'
import assert from 'node:assert/strict'

// config.ts reads the environment at module load, so the signing secret has to
// exist BEFORE ./vote.ts is imported — hence the await import rather than a
// static one at the top of the file.
process.env.VOTE_SIGNING_SECRET = 'test-signing-secret'
const { signState, verifyState, sameOrigin } = await import('./vote.ts')

// PUBLIC_URL is unset here, so sameOrigin falls back to the request's own
// origin — which is what these Requests are built against.
const post = (headers: Record<string, string>) =>
  new Request('https://votes.example/api/vote', { method: 'POST', headers })

test('sameOrigin accepts our own page and rejects everyone else', () => {
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'same-origin' })), true)
  // The whole point: an already-authorized visitor lured into submitting from
  // somewhere else must not have a vote cast in their name.
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'same-site' })), false)
  assert.equal(sameOrigin(post({ 'sec-fetch-site': 'none' })), false)
})

test('sameOrigin falls back to Origin, and refuses when neither header is sent', () => {
  assert.equal(sameOrigin(post({ origin: 'https://votes.example' })), true)
  assert.equal(sameOrigin(post({ origin: 'https://evil.example' })), false)
  // Sec-Fetch-Site wins when both are present: the browser sets it, so a
  // hand-written Origin cannot talk its way past a cross-site verdict.
  assert.equal(
    sameOrigin(post({ 'sec-fetch-site': 'cross-site', origin: 'https://votes.example' })),
    false
  )
  assert.equal(sameOrigin(post({})), false)
})

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

test('verifyState rejects a state that has aged out', () => {
  // Untouched blob, real signature — so the signature check cannot be what
  // rejects it, and expiry has to be enforced on its own. Editing `e` in place
  // would not test that: the mac would no longer match and verification would
  // fail one step earlier, for the wrong reason.
  const state = signState({ issue: 42, direction: 'down' })
  assert.deepEqual(verifyState(state), { issue: 42, direction: 'down' })

  // Move the clock instead. STATE_TTL_MS is 10 minutes; an hour is past it by
  // any margin, and still inside the window at the half-way check below.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 5 * 60_000
    // Still fresh: the state does not expire early, and this half of the
    // assertion is what proves the clock stub itself is doing something.
    assert.deepEqual(verifyState(state), { issue: 42, direction: 'down' })

    Date.now = () => realNow() + 60 * 60_000
    assert.equal(verifyState(state), null)
  } finally {
    Date.now = realNow
  }

  // And it verifies again once the clock is back — nothing about the blob
  // itself was damaged.
  assert.deepEqual(verifyState(state), { issue: 42, direction: 'down' })
})

test('signState produces a distinct blob each time', () => {
  // The nonce: two identical votes must not yield a shared, cacheable string.
  const a = signState({ issue: 1, direction: 'up' })
  const b = signState({ issue: 1, direction: 'up' })
  assert.notEqual(a, b)
})
