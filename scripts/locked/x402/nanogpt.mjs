#!/usr/bin/env node
/**
 * FROZEN — NanoGPT (nano-gpt.com) x402 fallback inference provider.
 *
 * x402gate.io (x402gate.mjs) is the primary inference path. NanoGPT is a
 * second, independent x402-accepting provider, added after a real x402gate.io
 * outage (2026-08-10: a burst of upstream 502s followed by a non-retryable 404
 * "Application not found" that killed a whole implement run with no recourse).
 * It sits behind x402gate.io — runModelSequence in x402gate.mjs only reaches
 * this module once every configured model has failed against the primary.
 *
 * Same wallet, same chain, same signing scheme: NanoGPT's accountless x402
 * offers a Base/USDC "exact" EVM scheme (eip155:8453), which is exactly what
 * ExactEvmScheme (@x402/evm) already signs for x402gate.io — no new wallet, no
 * new chain, no new dependency (see install-x402-deps.sh, unchanged).
 *
 * The DIALECT differs, though, so none of x402gate.mjs's payment plumbing is
 * reusable as-is:
 *  - x402gate.io: custom `PAYMENT-SIGNATURE` header wrapping {x402Version,
 *    payload, accepted} as base64 JSON, plus a prepaid-balance abstraction
 *    (X-PREPAID-*, GET /v1/balance, POST /v1/topup) so most requests don't
 *    pay per-call at all.
 *  - NanoGPT: no prepaid balance — every request is quoted and paid fresh.
 *    Send `x-x402: true` with no Authorization; a 402 carries a spec-shaped
 *    `accepts[]` (their docs also surface a friendlier `payment.accepted[]`
 *    mirroring the same options); sign once with the spec-standard `X-PAYMENT`
 *    header (base64 of the payment payload) and replay the SAME request.
 *  - Model ids are plain `provider/model-id` — x402gate.io's `~` prefix (its
 *    own dialect, not part of x402) means nothing here and must be stripped.
 *  - Their accountless x402 chat endpoint only accepts `stream:false`. Already
 *    true by the time a request reaches here: x402gate.mjs un-streams every
 *    agent request before either provider ever sees it.
 *
 * CAVEAT: the request/response shapes above come from NanoGPT's published
 * docs (docs.nano-gpt.com/api-reference/miscellaneous/x402), not a live call —
 * this module has not been exercised against a real payment. Send one small
 * real request through it and confirm a real reply before relying on it in a
 * run — the same "registering is not using" rule AGENTS.md already states for
 * any model or provider that hasn't been proven to answer.
 */
import { x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'

export const NANOGPT_BASE = (process.env.NANOGPT_BASE_URL || 'https://nano-gpt.com/api/v1').replace(
  /\/$/,
  ''
)

/** Same scheme registration as x402gate.mjs's makeClient — Base EVM exact
 *  scheme only. NanoGPT's other rails (Nano, Solana, Lightning) are not
 *  wired: this wallet only ever holds Base USDC. */
export function makeNanoGptClient(account) {
  const client = new x402Client()
  client.register('eip155:8453', new ExactEvmScheme(account))
  return client
}

/** x402gate.io model ids may carry a leading "~" (its own dialect). NanoGPT
 *  takes plain "provider/model-id". */
export function toNanoGptModel(model) {
  return model.replace(/^~/, '')
}

/**
 * Pay a NanoGPT 402 and return the paid Response. `assertSpendAllowed` is
 * x402gate.mjs's on-chain half-balance check, passed in rather than
 * duplicated — one spend-cap authority for the one wallet, whichever
 * provider ends up getting paid.
 */
async function payAndRetryNanoGpt(url, init, client, assertSpendAllowed) {
  const probeHeaders = new Headers(init.headers || {})
  probeHeaders.set('x-x402', 'true')
  probeHeaders.delete('Authorization')
  const res = await fetch(url, { ...init, headers: probeHeaders })
  if (res.status !== 402) return res
  await assertSpendAllowed()
  const quote = await res.json()
  // Prefer the spec-standard `accepts[]` (what createPaymentPayload expects
  // verbatim); fall back to the friendlier `payment.accepted[]` NanoGPT's docs
  // describe, in case a deployment only surfaces that one.
  const accepted = quote.accepts || quote.payment?.accepted
  const accept = accepted?.find(
    (a) => String(a.network ?? '').includes('eip155:8453') || String(a.network ?? '').includes('base')
  )
  if (!accept) throw new Error('No Base/USDC payment option in NanoGPT 402')
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    accepts: [accept],
    resource: url,
  })
  const headers = new Headers(probeHeaders)
  headers.set('X-PAYMENT', Buffer.from(JSON.stringify(payload)).toString('base64'))
  return fetch(url, { ...init, headers })
}

/**
 * One call to NanoGPT's chat completions. `bodyBuf` must already carry
 * stream:false (guaranteed by the time x402gate.mjs reaches this fallback)
 * and a NanoGPT-shaped model id (toNanoGptModel).
 */
export async function callNanoGpt(client, bodyBuf, assertSpendAllowed) {
  const url = `${NANOGPT_BASE}/chat/completions`
  const upstream = await payAndRetryNanoGpt(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyBuf },
    client,
    assertSpendAllowed
  )
  const text = await upstream.text()
  let unwrapped = null
  try {
    unwrapped = JSON.parse(text)
  } catch {
    /* leave null — caller treats a non-JSON body as a failed attempt */
  }
  return { upstream, text, unwrapped }
}
