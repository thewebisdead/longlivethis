/**
 * FROZEN — how x402inference.com says "come back in a moment".
 *
 * Split from x402inference.mjs, which cannot be imported without viem and the
 * x402 SDK, so the frozen test can exercise this against real captured
 * responses. Pure: no network, no wallet, no dependencies.
 */

/**
 * Gateway error codes meaning "come back in a moment", in both the shapes this
 * gateway has used.
 *
 * Since Aug 2026 these arrive as a plain `503` naming themselves in the JSON
 * body (`{"error":{"code":"channel_busy",…}}`) with a `Retry-After` — the shape
 * any HTTP client already understands. Before that they were a BARE 402 with an
 * empty body and the code only in the base64 `payment-required` header, which
 * is what killed an 18-minute run: a 402 carrying an `accepts` offer tells a
 * client to sign and retry, but signing cannot unlock a busy channel, and the
 * client's own SDK treats 402 as fatal.
 *
 * BOTH shapes stay recognised. The gateway's fix shipped on its own schedule
 * and this repo does not control when — nor whether it is ever rolled back.
 *
 * What they have in common: neither is the wallet's fault nor the model's. The
 * cure is to wait — not to retry briskly, and not to try a different model,
 * which would have to pay through the very same channel.
 */
export const BUSY_CODES = new Set([
  'channel_busy', // 503, current
  'channel_state_unavailable', // 503, transient channel-storage blip
  'invalid_batch_settlement_evm_channel_busy', // legacy bare 402
  'invalid_batch_settlement_evm_verification_state_unavailable', // legacy bare 402
])

/**
 * Codes meaning the wallet cannot pay, whatever the retry schedule does.
 *
 * These are TERMINAL — the opposite of BUSY_CODES. Waiting cannot fix an empty
 * channel, so the proxy hands them through as a fatal 402 and lets the run end
 * promptly rather than spending the rest of its budget on requests that are
 * guaranteed to be refused.
 *
 * EMPTY, pending the gateway naming its out-of-funds code (asked Aug 2026). Add
 * the code here and both the classification and the fast-fail come for free —
 * the mechanism is already wired and tested. Until then this case degrades to
 * the busy path: it retries, fails, and costs a run's budget instead of a run's
 * first minute. The local spend cap (spend-cap.mjs) is already covered and does
 * not depend on this.
 */
export const INSUFFICIENT_FUNDS_CODES = new Set([])

/**
 * Extra patience on top of whatever maximum busy window the gateway advertises:
 * `max_busy_seconds` bounds the LOCK, and a request that arrives just before
 * one starts has to outlast the whole of it plus its own settlement.
 */
export const CHANNEL_BUSY_SLACK_MS = 60_000

/** Decode the gateway's base64-JSON `payment-required` header; null if absent or garbage. */
export function paymentRequired(response) {
  const raw = response?.headers?.get?.('payment-required')
  if (!raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The gateway's reason for refusing, from the JSON body if it says (current), or
 * the base64 payment header if that is all there is (legacy). Null if neither.
 */
export function errorCode(response, body) {
  const fromBody = body?.error?.code
  if (typeof fromBody === 'string' && fromBody) return fromBody
  const fromHeader = paymentRequired(response)?.error
  return typeof fromHeader === 'string' && fromHeader ? fromHeader : null
}

/**
 * Classify a failed upstream response for the proxy's retry logic (the proxy is
 * provider-neutral and does not know this gateway's error codes). Returns
 * `{ kind, budgetMs? }`, or null for "nothing special — an ordinary failure".
 *
 * Deliberately NOT classified as busy: a 402
 * `invalid_batch_settlement_evm_cumulative_amount_mismatch`. That one is
 * corrective rather than transient — it carries an `accepts` offer and a
 * `channelState` the SDK re-derives a voucher from, and is the normal way a
 * client resynchronises after a streamed response. Waiting it out would be
 * exactly wrong.
 */
export function classifyFailure(response, body) {
  const code = errorCode(response, body)
  if (!code) return null
  if (INSUFFICIENT_FUNDS_CODES.has(code)) return { kind: 'insufficient-funds' }
  if (!BUSY_CODES.has(code)) return null
  // The gateway bounds and advertises its own lock window (`max_busy_seconds`,
  // 330s at the time of writing: a 300s upstream cap plus settlement slack).
  // Sizing the wait off that rather than a local constant keeps this correct
  // when the gateway retunes.
  const advertised = Number(body?.error?.max_busy_seconds)
  return {
    kind: 'channel-busy',
    budgetMs:
      Number.isFinite(advertised) && advertised > 0
        ? advertised * 1000 + CHANNEL_BUSY_SLACK_MS
        : undefined,
  }
}
