#!/usr/bin/env node
/**
 * Shared x402inference.com helpers for the agent — batch-settlement channel:
 * deposit once, then cheap voucher-only requests until the channel needs a
 * top-up (init already funded it; a run only deposits again if it runs the
 * balance down).
 * Deps (installed by agent.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createServer } from 'node:http'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { BatchSettlementEvmScheme, toClientEvmSigner } from '@x402/evm'
import { makeAccount } from '../lib/wallet.mjs'
import { USDC_BASE } from '../lib/constants.mjs'

export { makeAccount }

export const X402INFERENCE = (process.env.INFERENCE_BASE_URL || 'https://x402inference.com/accountless').replace(
  /\/$/,
  ''
)
export const GATEWAY_ORIGIN = X402INFERENCE.replace(/\/accountless$/, '') || 'https://x402inference.com'

// --- Per-run spend cap: one run may spend at most HALF of the wallet's ------
// USDC balance at run start. Checked on-chain before every payment (top-up or
// per-request), so runaway loops — including anything malicious that reaches
// the local proxy — degrade the run instead of draining the wallet.
const chain = createPublicClient({ chain: base, transport: http() })

async function walletUsdc(address) {
  const raw = await chain.readContract({
    address: USDC_BASE,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
            inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [address],
  })
  return Number(raw) / 1e6
}

let spendFloorUsd = null
let capAddress = null

async function initSpendCap(account) {
  if (spendFloorUsd !== null) return
  try {
    const bal = await walletUsdc(account.address)
    capAddress = account.address
    spendFloorUsd = bal / 2
    console.error(`[x402inference] spend cap: wallet $${bal.toFixed(2)} USDC — this run stops paying below $${spendFloorUsd.toFixed(2)}`)
  } catch (e) {
    // Fail open (like the run cooldown): an RPC hiccup must not kill the loop.
    console.error(`[x402inference] warning: could not read wallet balance for spend cap: ${e?.message || e}`)
  }
}

async function assertSpendAllowed() {
  if (spendFloorUsd === null) return
  let bal
  try {
    bal = await walletUsdc(capAddress)
  } catch {
    return // fail open on RPC errors; the cap re-checks on the next payment
  }
  if (bal < spendFloorUsd) {
    throw new Error(
      `spend cap reached: wallet $${bal.toFixed(2)} USDC is below half of the run-start balance ($${spendFloorUsd.toFixed(2)}) — refusing further payments this run`
    )
  }
}

// x402inference's batch-settlement scheme rejects any deposit under 1000
// atomic units ($0.001) — bisected against this same endpoint (longlive repo,
// scratch/bisect-deposit-floor.ts). A bare "just the required top-up" deposit
// strategy signs exactly that kind of dust once a channel has partial
// headroom (real per-request cost is tens–hundreds of atomic units), and every
// top-up after the first would be rejected with amount_too_low. Pad every
// deposit past the floor regardless of the route's advertised ceiling.
const DUST_FLOOR_ATOMIC = 2000n // 2x the measured floor, safety margin

function depositStrategy(context) {
  const min = BigInt(context.minimumDepositAmount)
  const padded = min * 5n
  const amount = padded > DUST_FLOOR_ATOMIC ? padded : DUST_FLOOR_ATOMIC
  return (amount > min ? amount : min).toString()
}

/**
 * Builds the batch-settlement client. No explicit channel salt: every process
 * (init's provisioning probe, and every future agent run) that builds this for
 * the same signer + receiver derives the SAME channel and recovers its
 * on-chain balance automatically, so a fresh run reuses funding from earlier
 * runs instead of depositing again.
 */
export function makeClient(account, publicClient) {
  const signer = toClientEvmSigner(account, publicClient)
  const scheme = new BatchSettlementEvmScheme(signer, { depositStrategy })
  const client = new x402Client().register('eip155:8453', scheme)
  return { client, scheme }
}

// A batch-settlement channel is stateful local-side (cumulative voucher
// amount, recovered balance): unlike the old x402gate prepaid headers —
// stateless signed messages, safe from any number of callers at once —
// two concurrent payAndRetry calls both read the same local channel state,
// both sign a voucher against it, and the second one to land is a stale
// claim the server rejects. opencode's "Implement" step runs a full agentic
// session that can fire concurrent tool calls, so this WILL happen under the
// old fire-and-forget shape. Serialize every call through the queue below —
// each payment fully lands (payload creation, upstream call, local state
// update) before the next one starts.
let paymentQueue = Promise.resolve()

/** Pay (voucher-only if the channel already has headroom, deposit + voucher otherwise) and return the response. */
export async function payAndRetry(url, init, client) {
  const run = async () => {
    await assertSpendAllowed()
    return wrapFetchWithPayment(fetch, client)(url, init)
  }
  const result = paymentQueue.then(run, run)
  // Never let one caller's rejection break the queue for callers behind it.
  paymentQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export async function ensureAuth() {
  const account = makeAccount()
  const publicClient = createPublicClient({ chain: base, transport: http() })
  const { client, scheme } = makeClient(account, publicClient)
  await initSpendCap(account)
  return { account, client, scheme }
}

/**
 * Reclaim whatever's left of the channel's deposit back to the wallet. Called
 * once, at the very end of the job (see agent.yml's "Recover x402inference
 * budget" step) — every run deposits at least a small padded top-up
 * (depositStrategy above), and leaving that sitting in the channel between
 * runs is USDC the spend cap can't see and the operator can't spend elsewhere.
 * A cooperative refund, not a withdrawal: settles immediately, no
 * withdrawDelay wait.
 */
export async function refundChannel(scheme) {
  const settle = await scheme.refund(`${GATEWAY_ORIGIN}/accountless/chat/completions`)
  console.error(`[x402inference] refund: reclaimed ${settle.amount ?? '0'} atomic units`)
  return settle
}

/** Turn a non-streaming chat.completion into SSE chunks (opencode always requests stream:true). */
function completionToSse(completion) {
  const choice = completion.choices?.[0] || {}
  const msg = choice.message || {}
  const finish =
    choice.finish_reason || (msg.tool_calls?.length ? 'tool_calls' : 'stop')
  const delta = { role: msg.role || 'assistant' }
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    delta.content = msg.content
  }
  if (msg.tool_calls?.length) {
    delta.tool_calls = msg.tool_calls.map((tc, i) => ({
      index: tc.index ?? i,
      id: tc.id,
      type: tc.type || 'function',
      function: {
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? '',
      },
    }))
  }
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  }
  const c1 = { ...base, choices: [{ index: 0, delta, finish_reason: null }] }
  const c2 = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: completion.usage,
  }
  return `data: ${JSON.stringify(c1)}\n\ndata: ${JSON.stringify(c2)}\n\ndata: [DONE]\n\n`
}

function summarizeCompletion(unwrapped, rawText) {
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

function unwrapGateBody(text) {
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

/** Configured model priority list (the INFERENCE_MODEL repo variable,
 *  comma-separated in preference order); the first entry is the default
 *  primary. Required, with no baked-in fallback: a retired model id is fixed by
 *  editing the variable, and a stale hardcoded default would hide that. */
function configuredModels() {
  const models = (process.env.INFERENCE_MODEL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!models.length) {
    throw new Error(
      'INFERENCE_MODEL is empty — set the INFERENCE_MODEL repo variable to a model id ' +
        '(e.g. anthropic/claude-sonnet-5), optionally a comma-separated fallback list.'
    )
  }
  return models
}

/** Models to try, in order. The proxy retries down the list when a model
 *  returns finish_reason=error / 429 / 5xx (e.g. Gemini tool bugs). A single
 *  entry means no fallback; a non-chat path never falls back (it carries no
 *  model to swap). */
function pickModelSequence(primary, isChat) {
  if (!isChat) return [primary]
  return [...new Set([primary, ...configuredModels()].filter(Boolean))]
}

function isFinishError(unwrapped) {
  return unwrapped?.choices?.[0]?.finish_reason === 'error'
}

function isRetryableHttp(status) {
  return status === 429 || status >= 500
}

function salvageFinishError(unwrapped) {
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

/**
 * Read the incoming request body, and — for a chat completion the agent asked
 * to stream — rewrite it as a non-streaming request. The gateway answers
 * buffered; `wantStream` tells convertResponse to re-emit the answer as SSE.
 * Returns { body, wantStream, primaryModel }.
 */
async function readRequestBody(req, isChat) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks)
  const out = { body: raw, wantStream: false, primaryModel: configuredModels()[0] }
  if (!raw.length || !isChat) return out
  try {
    const j = JSON.parse(raw.toString('utf8'))
    out.wantStream = !!j.stream
    if (j.model) out.primaryModel = j.model
    if (out.wantStream) {
      j.stream = false
      delete j.stream_options
      out.body = Buffer.from(JSON.stringify(j))
    }
  } catch {
    /* leave body */
  }
  return out
}

/** One upstream call: pay (deposit if the channel needs it, voucher-only otherwise) and read the body. */
async function callUpstream(ctx, bodyBuf) {
  const body = bodyBuf.length ? bodyBuf : undefined
  const upstream = await payAndRetry(ctx.target, { method: ctx.method, headers: ctx.headers, body }, ctx.client)
  const text = await upstream.text()
  return { upstream, text, unwrapped: unwrapGateBody(text) }
}

/**
 * Try one model. A provider error (finish_reason=error, 429, 5xx) is retried
 * once against the SAME model after a short delay — these are usually
 * transient. No re-auth needed: the channel stays valid across retries.
 * Returns the last attempt.
 */
async function tryUpstream(ctx, bodyBuf, model) {
  let result = await callUpstream(ctx, bodyBuf)
  const { upstream, text, unwrapped } = result
  if ((upstream.ok && isFinishError(unwrapped)) || isRetryableHttp(upstream.status)) {
    console.error(`[x402inference] model=${model} ${summarizeCompletion(unwrapped, text)} — retrying once`)
    await new Promise((r) => setTimeout(r, 400))
    result = await callUpstream(ctx, bodyBuf)
  }
  return result
}

/**
 * Walk the model sequence until one answers usefully. Returns the last
 * attempt plus the model that produced it (`usedModel`) — which, when every
 * candidate failed, is the last one tried.
 */
async function runModelSequence(ctx, reqBody, candidates, isChat) {
  const primary = candidates[0]
  let result = null
  let usedModel = primary
  for (const model of candidates) {
    if (model !== primary) console.error(`[x402inference] trying fallback model=${model}`)
    result = await tryUpstream(ctx, isChat ? bodyWithModel(reqBody, model) : reqBody, model)
    usedModel = model
    const { upstream, text, unwrapped } = result

    if (upstream.ok && isFinishError(unwrapped) && salvageFinishError(unwrapped)) {
      console.error(
        `[x402inference] salvaged finish_reason=error → ${unwrapped.choices[0].finish_reason} (model=${model})`
      )
      break
    }
    if (upstream.ok && !isFinishError(unwrapped)) {
      if (model !== primary) console.error(`[x402inference] fallback succeeded model=${model}`)
      break
    }
    console.error(
      `[x402inference] model=${model} failed: status=${upstream.status} ${summarizeCompletion(unwrapped, text)}`
    )
  }
  return { ...result, usedModel }
}

/** Write the gateway's answer back to the agent (SSE when it asked to stream). */
function convertResponse(res, { upstream, text, unwrapped, usedModel, wantStream }) {
  if (!upstream.ok) {
    console.error(`[x402inference] upstream ${upstream.status}: ${text.slice(0, 800)}`)
  } else {
    console.error(
      `[x402inference] upstream ${upstream.status} model=${usedModel} (${text.length} bytes) ${summarizeCompletion(unwrapped, text)}`
    )
  }

  // Never hand the agent finish_reason=error — it aborts the whole agent run.
  if (upstream.ok && isFinishError(unwrapped)) {
    const choice = unwrapped.choices[0]
    choice.message = choice.message || { role: 'assistant', content: '' }
    if (!choice.message.content) {
      choice.message.content =
        'Provider returned an error on the last turn. Continue with the next tool or step.'
    }
    choice.finish_reason = 'stop'
    delete choice.native_finish_reason
    console.error(`[x402inference] forced stop after exhausted fallbacks (model=${usedModel})`)
  }

  if (wantStream && unwrapped?.choices) {
    res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream' })
    res.end(completionToSse(unwrapped))
    return
  }
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  })
  res.end(unwrapped ? JSON.stringify(unwrapped) : text)
}

/**
 * Handle one proxied request: read (and un-stream) the body, try the model
 * sequence, write the answer back. `auth.client` is shared across requests —
 * the batch-settlement channel it holds is what makes repeat requests cheap.
 */
async function handleRequest(auth, req, res) {
  const path = req.url || '/'
  try {
    const isChat = path.includes('chat/completions')
    const { body, wantStream, primaryModel } = await readRequestBody(req, isChat)
    const sub = path.replace(/^\/v1\//, '')
    const ctx = {
      client: auth.client,
      method: req.method || 'POST',
      target: `${GATEWAY_ORIGIN}/accountless/${sub}`,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
    }
    console.error(
      `[x402inference] ${req.method} ${path} → ${ctx.target}${wantStream ? ' (stream→buffered)' : ''}`
    )

    const attempt = await runModelSequence(ctx, body, pickModelSequence(primaryModel, isChat), isChat)
    convertResponse(res, { ...attempt, wantStream })
  } catch (err) {
    console.error(`[x402inference] ERROR ${path}:`, err?.stack || err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  }
}

/**
 * POST /__refund — local-only, called once by agent.yml's last step to
 * reclaim the channel's unused balance before the job ends. Not under /v1,
 * so it's never reachable through anything an OpenAI-compatible client (or a
 * hostile proposal that only ever talks to PROXY_BASE/v1) could construct.
 */
async function handleRefundRequest(auth, res) {
  try {
    const settle = await refundChannel(auth.scheme)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(settle))
  } catch (err) {
    console.error(`[x402inference] refund failed: ${err?.stack || err}`)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  }
}

/** Local OpenAI-compatible proxy so the agent can talk to x402inference. */
export async function startProxy(port = 0) {
  const auth = await ensureAuth() // { account, client, scheme }
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__refund') {
      handleRefundRequest(auth, res)
      return
    }
    handleRequest(auth, req, res)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  const origin = `http://127.0.0.1:${addr.port}`
  return { server, port: addr.port, baseUrl: `${origin}/v1`, refundUrl: `${origin}/__refund` }
}
