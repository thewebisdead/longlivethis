/**
 * FROZEN — regression tests for the proxy's retry policy (../x402/retry.mjs).
 *
 * These exist because the loop has already been killed by exactly the failures
 * asserted below. A sweep on 2026-08-12 lost 18 minutes of finished work when
 * an edge timeout (524) left the payment channel locked, the proxy waited nine
 * seconds across two models, and handed the agent a bare 402 — which its client
 * treats as fatal. Every assertion here is one link of that chain.
 *
 * Imports retry.mjs alone, on purpose: it depends on nothing, so this file runs
 * under plain `node --test` with no npm install, no wallet and no network.
 *
 * Run: node --test scripts/locked/tests/proxy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_BUSY_BUDGET_MS,
  MAX_ATTEMPTS,
  runModelSequence,
  tryUpstream,
} from '../x402/retry.mjs'
// The REAL x402inference classifier, not a stand-in: the tests below assert on
// the gateway's actual response shapes, so they have to run its actual codes.
import { classifyFailure as busyClassifier } from '../x402/providers/x402inference-errors.mjs'

/** A Response-alike carrying just what the retry policy reads. */
function reply(status, body = '{}', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
  }
}

/** The gateway's current busy refusal: 503, self-naming body, Retry-After. */
function busy503({ retryAfter = 5, maxBusy = 330 } = {}) {
  return reply(
    503,
    JSON.stringify({
      error: {
        code: 'channel_busy',
        message: 'another request on this payment channel is still in flight',
        retry_after_seconds: retryAfter,
        max_busy_seconds: maxBusy,
      },
    }),
    { 'retry-after': retryAfter }
  )
}

const OK_BODY = JSON.stringify({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
})

/**
 * A fake session that answers a scripted list of responses (the last one repeats
 * forever), records every wait it was asked to make, and classifies failures the
 * way the real x402inference adapter does.
 *
 * `busyStatuses` is the crude stand-in used by tests that only care about the
 * retry SHAPE; tests that care about classification pass `classify` instead.
 */
function fakeCtx(script, { busyStatuses = [402], classify } = {}) {
  const waits = []
  let i = 0
  const ctx = {
    method: 'POST',
    path: '/v1/chat/completions',
    target: 'https://gateway.example/chat/completions',
    headers: {},
    calls: 0,
    waits,
    wait: async (ms) => {
      waits.push(ms)
    },
    session: {
      async fetch() {
        ctx.calls++
        const next = script[Math.min(i, script.length - 1)]
        i++
        return typeof next === 'function' ? next() : next
      },
      async refresh() {},
      failureKind(res, body) {
        if (classify) return classify(res, body)
        return busyStatuses.includes(res.status) ? { kind: 'channel-busy' } : null
      },
    },
  }
  return ctx
}

const BODY = Buffer.from(JSON.stringify({ model: 'a/model', messages: [] }))

test('an ordinary transient error is retried MAX_ATTEMPTS times, no more', async () => {
  const ctx = fakeCtx([reply(500)], { busyStatuses: [] })
  const { upstream } = await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(upstream.status, 500)
  assert.equal(ctx.calls, MAX_ATTEMPTS)
  assert.deepEqual(ctx.waits, [3000, 6000])
})

test('a locked channel is waited out far past the ordinary attempt budget', async () => {
  // The regression: this used to give up after two waits totalling 9s.
  const ctx = fakeCtx([reply(402)])
  await tryUpstream(ctx, BODY, 'a/model')
  const waited = ctx.waits.reduce((a, b) => a + b, 0)
  assert.ok(ctx.calls > MAX_ATTEMPTS, `only ${ctx.calls} calls — channel-busy must outlive MAX_ATTEMPTS`)
  assert.ok(waited > 60_000, `only waited ${waited}ms — a locked channel needs minutes`)
  assert.ok(waited <= CHANNEL_BUSY_BUDGET_MS, `waited ${waited}ms, over the ${CHANNEL_BUSY_BUDGET_MS}ms budget`)
})

test('a channel that frees up mid-wait is used immediately', async () => {
  const ctx = fakeCtx([reply(402), reply(402), reply(200, OK_BODY)])
  const { upstream } = await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(upstream.status, 200)
  assert.equal(ctx.calls, 3)
})

test('the channel-busy wait does not consume the ordinary attempt budget', async () => {
  // Channel busy twice, then the model itself misbehaves: the model still gets
  // its full MAX_ATTEMPTS, because the two failures are unrelated.
  const script = [reply(402), reply(402), reply(500), reply(500), reply(500), reply(500)]
  const ctx = fakeCtx(script)
  await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(ctx.calls, 2 + MAX_ATTEMPTS)
})

test('a locked channel does not send the request down the model list', async () => {
  // Every model pays through the same channel, so a fallback cannot get past it
  // — it would only burn clock. The old behaviour tried each model in turn.
  const ctx = fakeCtx([reply(402)])
  const { usedModel } = await runModelSequence(ctx, BODY, ['a/model', 'b/model'], true)
  assert.equal(usedModel, 'a/model')
})

test('an ordinary failure still falls down the model list', async () => {
  const ctx = fakeCtx(
    [reply(500), reply(500), reply(500), reply(200, OK_BODY)],
    { busyStatuses: [] }
  )
  const { usedModel, upstream } = await runModelSequence(ctx, BODY, ['a/model', 'b/model'], true)
  assert.equal(usedModel, 'b/model')
  assert.equal(upstream.status, 200)
})

test('a provider adapter without failureKind() still works', async () => {
  const ctx = fakeCtx([reply(500)], { busyStatuses: [] })
  delete ctx.session.failureKind
  const { upstream } = await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(upstream.status, 500)
  assert.equal(ctx.calls, MAX_ATTEMPTS)
})

// --- The gateway's Aug-2026 contract: 503 + Retry-After + a self-naming body --

test('the busy budget comes from the gateway’s advertised max_busy_seconds', async () => {
  // 90s advertised + 60s slack: the wait must outlast the window it names, and
  // must NOT spend the local 300s fallback when the gateway has said otherwise.
  const ctx = fakeCtx([busy503({ maxBusy: 90 })], { classify: busyClassifier })
  await tryUpstream(ctx, BODY, 'a/model')
  const waited = ctx.waits.reduce((a, b) => a + b, 0)
  assert.ok(waited > 90_000, `waited ${waited}ms — must outlast the advertised 90s window`)
  assert.ok(waited <= 150_000, `waited ${waited}ms — should not exceed 90s + slack`)
})

test('Retry-After is honoured as a floor, never faster than the gateway asked', async () => {
  const ctx = fakeCtx([busy503({ retryAfter: 25 })], { classify: busyClassifier })
  await tryUpstream(ctx, BODY, 'a/model')
  assert.ok(
    ctx.waits.every((w) => w >= 25_000),
    `waits ${ctx.waits} — none may undercut the 25s the gateway asked for`
  )
})

test('a Retry-After longer than a run can spare fails fast instead of idling', async () => {
  // `daily_limit_exceeded` points at 00:00 UTC — hours away. Sleeping that off
  // inside a one-hour budget burns the run for nothing.
  const ctx = fakeCtx([reply(429, '{"error":{"code":"daily_limit_exceeded"}}', { 'retry-after': 7200 })], {
    busyStatuses: [],
  })
  const { upstream } = await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(upstream.status, 429)
  assert.equal(ctx.calls, 1, 'must not retry a refusal that cannot clear in time')
  assert.deepEqual(ctx.waits, [])
})

test('the legacy bare-402 busy shape is still recognised', async () => {
  // The gateway's fix ships on its own schedule; a rollback must not resurrect
  // the dead run. Same header the 2026-08-12 failure carried.
  const legacy = reply(402, '{}', {
    'payment-required': Buffer.from(
      JSON.stringify({ x402Version: 2, error: 'invalid_batch_settlement_evm_channel_busy', accepts: [] })
    ).toString('base64'),
  })
  const ctx = fakeCtx([legacy], { classify: busyClassifier })
  await tryUpstream(ctx, BODY, 'a/model')
  assert.ok(ctx.calls > MAX_ATTEMPTS, `only ${ctx.calls} calls — legacy busy 402 must still be waited out`)
})

test('a terminal insufficient-funds failure is not waited out', async () => {
  // Waiting cannot refill a wallet. The proxy hands this through as a fatal 402
  // so the run ends in its first minute rather than its last.
  const ctx = fakeCtx([reply(402, '{"error":{"code":"wallet_empty"}}')], {
    classify: () => ({ kind: 'insufficient-funds' }),
  })
  await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(ctx.calls, MAX_ATTEMPTS, 'must not take the long channel-busy wait')
  const waited = ctx.waits.reduce((a, b) => a + b, 0)
  assert.ok(waited < 30_000, `waited ${waited}ms — an empty wallet must fail fast`)
})

test('a corrective cumulative_amount_mismatch is NOT treated as busy', async () => {
  // It carries an accepts offer and a channelState the SDK re-derives a voucher
  // from — the normal resync after a streamed response. Waiting it out is wrong.
  const corrective = reply(402, '{"error":{"code":"invalid_batch_settlement_evm_cumulative_amount_mismatch"}}')
  const ctx = fakeCtx([corrective], { classify: busyClassifier })
  await tryUpstream(ctx, BODY, 'a/model')
  assert.equal(ctx.calls, MAX_ATTEMPTS, 'must take the ordinary retry path, not the long busy wait')
})
