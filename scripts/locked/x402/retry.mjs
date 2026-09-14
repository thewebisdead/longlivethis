/**
 * FROZEN — how the proxy survives a gateway having a bad minute.
 *
 * Lives in its own file, like serialize.mjs, because it is load-bearing and
 * needs to be TESTABLE: inference-proxy.mjs cannot be imported without the x402
 * SDK and a wallet, and the retry policy is exactly the part that must not be
 * allowed to silently regress. scripts/locked/tests/proxy.test.mjs imports this
 * module alone and runs the schedules against a fake session.
 *
 * Provider-neutral throughout: the one gateway-specific judgement (is this bare
 * 402 a locked payment channel, or a wallet that cannot pay?) is delegated to
 * the provider adapter's optional `failureKind()`.
 */

/** How many times one model is tried before falling down the model list. */
export const MAX_ATTEMPTS = 3

/**
 * A payment channel that another request still holds gets its OWN, far longer
 * retry budget, spent outside the MAX_ATTEMPTS allowance.
 *
 * The provider adapter names this condition (session.failureKind → 'channel-busy'
 * — only it can read a gateway's error codes). What it means is that the gateway
 * is still running a generation this proxy has already given up on: an upstream
 * request that times out at the edge (524) leaves the channel locked server-side
 * for as long as that generation keeps going, which can be minutes.
 *
 * The observed failure this exists to end: 524 → wait 3s → 402 busy → wait 6s →
 * 402 busy → attempts exhausted → fall to the second model → three more busy
 * 402s → a bare 402 handed to the agent, which ended an 18-minute run. Nine
 * seconds of patience against a lock measured in minutes. Waiting is also the
 * ONLY cure: every model pays through the same channel, so falling down the
 * model list cannot get past it (runModelSequence stops for that reason too).
 *
 * ONE IN-FLIGHT REQUEST PER CHANNEL IS THE PROTOCOL, not a gateway bug: every
 * voucher signs `chargedCumulativeAmount + thisRequestCeiling`, and the charged
 * total is only known at settlement, so a concurrent request has no base to sign
 * against. Confirmed by the gateway author (Aug 2026) — releasing the lock early
 * would need an x402 protocol change. serialize.mjs is therefore permanent.
 *
 * The budget below is only the FALLBACK. A gateway that advertises its own
 * maximum busy window (x402inference returns `max_busy_seconds` on the busy
 * 503) overrides it through failureKind().budgetMs, so this stays correct when
 * the gateway retunes its upstream timeout.
 */
export const CHANNEL_BUSY_BUDGET_MS = 300_000
export const CHANNEL_BUSY_WAITS_MS = [5000, 10_000, 20_000, 30_000]

/**
 * The longest single wait this proxy will make on a gateway's say-so.
 *
 * `Retry-After` is honoured (below), but not unconditionally: some refusals
 * self-clear in seconds and some do not clear within any useful window at all —
 * x402inference answers `daily_limit_exceeded` with a `Retry-After` running to
 * 00:00 UTC, which can be hours. Sleeping that off inside a one-hour
 * implementation budget would burn the entire run to no purpose, so a gateway
 * asking for longer than this is understood as "not within this run": the proxy
 * stops retrying and lets the request fail fast instead.
 */
const MAX_SINGLE_WAIT_MS = 60_000

/**
 * 402 counts as retryable, not fatal: on a channel-based provider it is what a
 * gateway answers while the escrow channel is momentarily unavailable (a batch
 * settlement in progress), and handing that straight back ends the whole agent
 * session. A 402 that means "this wallet cannot pay" simply fails again on the
 * retry, having spent nothing.
 *
 * 503 and 502 are here as part of `>= 500`: a well-behaved gateway reports every
 * self-clearing refusal that way (x402inference moved `channel_busy` from 402 to
 * 503 in Aug 2026), which is exactly the shape this already retries.
 */
export function isRetryableHttp(status) {
  return status === 402 || status === 429 || status >= 500
}

/**
 * The gateway's own answer to "how long should I wait", in ms, or null.
 *
 * Provider-NEUTRAL on purpose: honouring `Retry-After` covers every retryable
 * condition a gateway produces — including ones added after this code was
 * written — without the proxy having to learn a taxonomy of error codes. Both
 * RFC forms are accepted (delta-seconds and HTTP-date); a date in the past
 * reads as "now".
 */
function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

export function isFinishError(unwrapped) {
  return unwrapped?.choices?.[0]?.finish_reason === 'error'
}

/**
 * Backoff before the next same-model attempt, growing with each one. A gateway
 * error needs longer than a rate limit, so only a plain 429 gets the short wait.
 * A locked payment channel is not on this schedule at all — see above.
 */
export function retryDelayMs(status, attempt) {
  const base = status === 429 ? 400 : 3000
  return base * attempt
}

/**
 * Ask the provider adapter to classify a failure. Adapters need not implement
 * it; those that do get the parsed body as well as the response, since a modern
 * gateway names its reason in the JSON body rather than only in a payment
 * header. Returns `{ kind, budgetMs? }` or null.
 */
export function classifyFailure(session, response, body) {
  return session.failureKind?.(response, body) ?? null
}

/**
 * The retry wait. Overridable through `ctx.wait` for one reason only: the frozen
 * test has to exercise a schedule measured in minutes and cannot spend minutes
 * doing it. Nothing in the running proxy ever sets it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export function summarizeCompletion(unwrapped, rawText) {
  const choice = unwrapped?.choices?.[0]
  const fr = choice?.finish_reason
  const native = choice?.native_finish_reason
  const err = unwrapped?.error || choice?.error
  const content = choice?.message?.content
  const tools = choice?.message?.tool_calls?.map((t) => t.function?.name).filter(Boolean)
  const bits = [`finish_reason=${fr ?? '∅'}`]
  if (native) bits.push(`native=${native}`)
  if (tools?.length) bits.push(`tools=${tools.join(',')}`)
  if (typeof content === 'string' && content) bits.push(`content=${JSON.stringify(content.slice(0, 80))}`)
  if (err) bits.push(`error=${JSON.stringify(err).slice(0, 300)}`)
  if (fr === 'error' || err) bits.push(`raw=${rawText.slice(0, 600)}`)
  return bits.join(' ')
}

/** Some gateways wrap the OpenAI body in `{ data: … }`; unwrap when they do. */
function unwrapBody(text) {
  try {
    const j = JSON.parse(text)
    if (j && typeof j === 'object' && j.data && (j.data.choices || j.data.object)) return j.data
    return j
  } catch {
    return null
  }
}

function bodyWithModel(buf, model) {
  try {
    const j = JSON.parse(buf.toString('utf8'))
    j.model = model
    return Buffer.from(JSON.stringify(j))
  } catch {
    return buf
  }
}

/**
 * Salvage a `finish_reason=error` that nonetheless carries usable output: some
 * gateways flag an error while still returning the text or tool calls the model
 * produced. Mutates `unwrapped` and reports whether it rescued anything.
 */
export function salvageFinishError(unwrapped) {
  const choice = unwrapped?.choices?.[0]
  if (!choice || choice.finish_reason !== 'error') return false
  const msg = choice.message || {}
  const hasText = typeof msg.content === 'string' && msg.content.trim().length > 0
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  if (!hasText && !hasTools) return false
  choice.finish_reason = hasTools ? 'tool_calls' : 'stop'
  delete choice.native_finish_reason
  return true
}

/** One upstream call, paid by the provider session. */
async function callUpstream(ctx, bodyBuf) {
  const body = bodyBuf.length ? bodyBuf : undefined
  const upstream = await ctx.session.fetch(
    ctx.target,
    { method: ctx.method, headers: ctx.headers, body },
    ctx.path
  )
  const text = await upstream.text()
  return { upstream, text, unwrapped: unwrapBody(text) }
}

/**
 * Try one model. A provider error (finish_reason=error, 402, 429, 5xx) is
 * retried against the SAME model after the session refreshes whatever it needs
 * (a prepaid top-up, a channel deposit), on one of two budgets:
 *
 *   - an ordinary transient error: MAX_ATTEMPTS tries, seconds apart;
 *   - a locked payment channel: its own CHANNEL_BUSY_BUDGET_MS of patience,
 *     because that lock is held by a generation still running upstream and
 *     clears on its own schedule, not ours.
 *
 * The two budgets are independent on purpose: a request that spends five
 * minutes waiting out a channel still gets its full three tries at the model
 * afterwards, and a flaky model never eats the patience the channel needs.
 * Returns the last attempt.
 */
export async function tryUpstream(ctx, bodyBuf, model) {
  let result = await callUpstream(ctx, bodyBuf)
  let tries = 1 // ordinary attempts spent (the call above is the first)
  let busyWaited = 0 // ms already spent waiting out a locked channel
  let busyRound = 0

  for (;;) {
    const { upstream, text, unwrapped } = result
    if (!(upstream.ok && isFinishError(unwrapped)) && !isRetryableHttp(upstream.status)) break

    const failure = classifyFailure(ctx.session, upstream, unwrapped)
    const hinted = retryAfterMs(upstream)
    let delay
    let label

    if (failure?.kind === 'channel-busy') {
      // The gateway's own maximum busy window when it advertises one, so this
      // stays right through a retune on its side; the local fallback otherwise.
      const budget = failure.budgetMs ?? CHANNEL_BUSY_BUDGET_MS
      // Back off on the local schedule, but never faster than the gateway asked.
      const floor = CHANNEL_BUSY_WAITS_MS[Math.min(busyRound, CHANNEL_BUSY_WAITS_MS.length - 1)]
      delay = Math.max(floor, hinted ?? 0)
      if (busyWaited + delay > budget) {
        console.error(
          `[proxy] payment channel still busy after ${Math.round(busyWaited / 1000)}s (budget ${budget / 1000}s) — giving up on this request`
        )
        break
      }
      busyWaited += delay
      busyRound++
      label = `channel busy, ${Math.round(busyWaited / 1000)}s of ${budget / 1000}s spent waiting`
    } else {
      if (tries >= MAX_ATTEMPTS) break
      // A gateway that wants to be left alone for longer than a run can spare is
      // telling us this does not clear in time — fail fast rather than idle.
      if (hinted !== null && hinted > MAX_SINGLE_WAIT_MS) {
        console.error(
          `[proxy] gateway asked for ${Math.round(hinted / 1000)}s before a retry — longer than this run can usefully wait; not retrying`
        )
        break
      }
      delay = Math.max(retryDelayMs(upstream.status, tries), hinted ?? 0)
      tries++
      label = `attempt ${tries}/${MAX_ATTEMPTS}`
    }

    console.error(
      `[proxy] model=${model} status=${upstream.status} ${summarizeCompletion(unwrapped, text)} — retrying in ${delay}ms (${label})`
    )
    await (ctx.wait || wait)(delay)
    await ctx.session.refresh()
    result = await callUpstream(ctx, bodyBuf)
  }
  return result
}

/**
 * Walk the model sequence until one answers usefully. Returns the last
 * attempt plus the model that produced it (`usedModel`) — which, when every
 * candidate failed, is the last one tried.
 */
export async function runModelSequence(ctx, reqBody, candidates, isChat) {
  const primary = candidates[0]
  let result = null
  let usedModel = primary
  for (const model of candidates) {
    if (model !== primary) console.error(`[proxy] trying fallback model=${model}`)
    result = await tryUpstream(ctx, isChat ? bodyWithModel(reqBody, model) : reqBody, model)
    usedModel = model
    const { upstream, text, unwrapped } = result

    if (upstream.ok && isFinishError(unwrapped) && salvageFinishError(unwrapped)) {
      console.error(
        `[proxy] salvaged finish_reason=error → ${unwrapped.choices[0].finish_reason} (model=${model})`
      )
      break
    }
    if (upstream.ok && !isFinishError(unwrapped)) {
      if (model !== primary) console.error(`[proxy] fallback succeeded model=${model}`)
      break
    }
    console.error(
      `[proxy] model=${model} failed: status=${upstream.status} ${summarizeCompletion(unwrapped, text)}`
    )
    // Every model in the list pays through the SAME channel, so a channel that
    // is still locked defeats the next candidate exactly as it defeated this
    // one — falling down the list would only burn the clock while the lock
    // clears. Stop and let the caller hand back something retryable.
    if (classifyFailure(ctx.session, upstream, unwrapped)?.kind === 'channel-busy') {
      console.error('[proxy] channel busy is not a model problem — skipping the remaining models')
      break
    }
  }
  return { ...result, usedModel }
}
