#!/usr/bin/env node
/**
 * Shared x402gate.io helpers for the agent (prepaid + per-request pay).
 * Deps (installed by agent.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createServer } from 'node:http'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { makeAccount } from '../lib/wallet.mjs'
import { USDC_BASE } from '../lib/constants.mjs'
import { makeNanoGptClient, toNanoGptModel, callNanoGpt } from './nanogpt.mjs'

export { makeAccount }

export const X402GATE = (process.env.INFERENCE_BASE_URL || 'https://x402gate.io/v1/openrouter').replace(
  /\/$/,
  ''
)
export const GATEWAY_ORIGIN = X402GATE.includes('/v1/openrouter')
  ? X402GATE.replace(/\/v1\/openrouter$/, '')
  : 'https://x402gate.io'

function sanitizeAccept(accept) {
  const { price: _p, ...rest } = accept
  return rest
}

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
    console.error(`[x402gate] spend cap: wallet $${bal.toFixed(2)} USDC — this run stops paying below $${spendFloorUsd.toFixed(2)}`)
  } catch (e) {
    // Fail open (like the run cooldown): an RPC hiccup must not kill the loop.
    console.error(`[x402gate] warning: could not read wallet balance for spend cap: ${e?.message || e}`)
  }
}

// Exported for nanogpt.mjs: one spend-cap authority for the one wallet,
// whichever provider ends up getting paid.
export async function assertSpendAllowed() {
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

export function makeClient(account) {
  const client = new x402Client()
  client.register('eip155:8453', new ExactEvmScheme(account))
  client.register('eip155:*', new ExactEvmScheme(account))
  return client
}

/** Pay a 402 from x402gate and return the paid Response. */
export async function payAndRetry(url, init, client) {
  let res = await fetch(url, init)
  if (res.status !== 402) return res
  await assertSpendAllowed()
  const payBody = await res.json()
  const accept = payBody.accepts?.find((a) => String(a.network).includes('eip155:8453'))
  if (!accept) throw new Error('No Base payment option in 402')
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    accepts: [sanitizeAccept(accept)],
    resource: url,
  })
  const wire = {
    x402Version: payload.x402Version,
    payload: payload.payload,
    accepted: sanitizeAccept(accept),
  }
  const headers = new Headers(init.headers || {})
  headers.set('PAYMENT-SIGNATURE', Buffer.from(JSON.stringify(wire)).toString('base64'))
  return fetch(url, { ...init, headers })
}

/** Prepaid balance for address (in-memory on gateway). */
export async function getPrepaidBalance(address) {
  const r = await fetch(`${GATEWAY_ORIGIN}/v1/balance/${address}`)
  if (!r.ok) return 0
  const j = await r.json()
  return parseFloat(j.balance || '0') || 0
}

/** Top up prepaid balance (USDC on Base). amount in USD. */
export async function topUpPrepaid(client, amountUsd = 0.5) {
  await assertSpendAllowed()
  const url = `${GATEWAY_ORIGIN}/v1/topup`
  const body = JSON.stringify({ amount: amountUsd })
  const res = await payAndRetry(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    client
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`topup failed: ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** EIP-191 prepaid headers for path like openrouter/chat/completions */
export async function prepaidHeaders(account, subPath) {
  const ts = Math.floor(Date.now() / 1000)
  const msg = `x402gate:${subPath}:${ts}`
  const signature = await account.signMessage({ message: msg })
  return {
    'X-PREPAID-PUBKEY': account.address,
    'X-PREPAID-SIGNATURE': signature,
    'X-PREPAID-TIMESTAMP': String(ts),
  }
}

export async function ensurePrepaid(minUsd = 0.05) {
  const account = makeAccount()
  const client = makeClient(account)
  await initSpendCap(account)
  let bal = await getPrepaidBalance(account.address)
  if (bal < minUsd) {
    console.error(`Prepaid balance $${bal} < $${minUsd} — topping up…`)
    const result = await topUpPrepaid(client, Math.max(0.5, minUsd))
    bal = parseFloat(result.balance || '0')
    console.error(`Prepaid balance now $${bal}`)
  }
  return { account, client, balance: bal }
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

/** One upstream call: pay a 402/401/403 and retry, then read the body. */
async function callUpstream(ctx, bodyBuf) {
  const body = bodyBuf.length ? bodyBuf : undefined
  let upstream = await fetch(ctx.target, { method: ctx.method, headers: ctx.headers, body })
  if (upstream.status === 402 || upstream.status === 401 || upstream.status === 403) {
    console.error(`[x402-proxy] ${upstream.status} — paying / retrying…`)
    Object.assign(ctx.headers, await prepaidHeaders(ctx.auth.account, ctx.subPath))
    upstream = await payAndRetry(
      ctx.target,
      { method: ctx.method, headers: { 'Content-Type': 'application/json' }, body },
      ctx.auth.client
    )
  }
  const text = await upstream.text()
  return { upstream, text, unwrapped: unwrapGateBody(text) }
}

/**
 * Try one model. A provider error (finish_reason=error, 429, 5xx) is retried
 * once against the SAME model after topping the prepaid balance back up —
 * these are usually transient. Returns the last attempt.
 */
async function tryUpstream(ctx, bodyBuf, model) {
  let result = await callUpstream(ctx, bodyBuf)
  const { upstream, text, unwrapped } = result
  if ((upstream.ok && isFinishError(unwrapped)) || isRetryableHttp(upstream.status)) {
    console.error(`[x402gate] model=${model} ${summarizeCompletion(unwrapped, text)} — retrying once`)
    await new Promise((r) => setTimeout(r, 400))
    ;({ account: ctx.auth.account } = await ensurePrepaid(0.05))
    Object.assign(ctx.headers, await prepaidHeaders(ctx.auth.account, ctx.subPath))
    result = await callUpstream(ctx, bodyBuf)
  }
  return result
}

// Lazily built once per proxy process: same wallet account as x402gate.io,
// registered against NanoGPT's plain x402 exact-EVM scheme.
let nanoGptClient = null

/**
 * Every x402gate.io candidate in `candidates` failed outright (not merely a
 * salvageable finish_reason=error — see runModelSequence). Try the same
 * models against NanoGPT (nanogpt.mjs), the second x402-accepting provider on
 * this wallet's own chain/asset, before the run gives up entirely. Returns
 * null if NanoGPT also produced nothing usable, so the caller falls back to
 * its existing exhausted-x402gate.io result (and its forced-stop message).
 */
async function tryNanoGptFallback(ctx, reqBody, candidates) {
  console.error('[x402gate] all x402gate.io candidates failed — falling back to NanoGPT')
  nanoGptClient = nanoGptClient || makeNanoGptClient(ctx.auth.account)
  for (const model of candidates) {
    const ngModel = toNanoGptModel(model)
    let result
    try {
      result = await callNanoGpt(nanoGptClient, bodyWithModel(reqBody, ngModel), assertSpendAllowed)
    } catch (e) {
      console.error(`[nanogpt] model=${ngModel} request failed: ${e?.message || e}`)
      continue
    }
    const { upstream, text, unwrapped } = result
    if (upstream.ok && isFinishError(unwrapped) && salvageFinishError(unwrapped)) {
      console.error(`[nanogpt] salvaged finish_reason=error → ${unwrapped.choices[0].finish_reason} (model=${ngModel})`)
      return { ...result, usedModel: model }
    }
    if (upstream.ok && !isFinishError(unwrapped)) {
      console.error(`[nanogpt] fallback succeeded model=${ngModel}`)
      return { ...result, usedModel: model }
    }
    console.error(`[nanogpt] model=${ngModel} failed: status=${upstream.status} ${summarizeCompletion(unwrapped, text)}`)
  }
  return null
}

/**
 * Walk the model sequence until one answers usefully. Returns the last
 * attempt plus the model that produced it (`usedModel`) — which, when every
 * candidate failed against BOTH providers, is the last one tried against
 * x402gate.io (so convertResponse's forced-stop message still applies).
 */
async function runModelSequence(ctx, reqBody, candidates, isChat) {
  const primary = candidates[0]
  let result = null
  let usedModel = primary
  for (const model of candidates) {
    if (model !== primary) console.error(`[x402gate] trying fallback model=${model}`)
    result = await tryUpstream(ctx, isChat ? bodyWithModel(reqBody, model) : reqBody, model)
    usedModel = model
    const { upstream, text, unwrapped } = result

    if (upstream.ok && isFinishError(unwrapped) && salvageFinishError(unwrapped)) {
      console.error(
        `[x402gate] salvaged finish_reason=error → ${unwrapped.choices[0].finish_reason} (model=${model})`
      )
      return { ...result, usedModel }
    }
    if (upstream.ok && !isFinishError(unwrapped)) {
      if (model !== primary) console.error(`[x402gate] fallback succeeded model=${model}`)
      return { ...result, usedModel }
    }
    console.error(
      `[x402gate] model=${model} failed: status=${upstream.status} ${summarizeCompletion(unwrapped, text)}`
    )
  }
  if (isChat) {
    const fromNanoGpt = await tryNanoGptFallback(ctx, reqBody, candidates)
    if (fromNanoGpt) return fromNanoGpt
  }
  return { ...result, usedModel }
}

/** Write the gateway's answer back to the agent (SSE when it asked to stream). */
function convertResponse(res, { upstream, text, unwrapped, usedModel, wantStream }) {
  if (!upstream.ok) {
    console.error(`[x402gate] upstream ${upstream.status}: ${text.slice(0, 800)}`)
  } else {
    console.error(
      `[x402gate] upstream ${upstream.status} model=${usedModel} (${text.length} bytes) ${summarizeCompletion(unwrapped, text)}`
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
    console.error(`[x402gate] forced stop after exhausted fallbacks (model=${usedModel})`)
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
 * sequence, write the answer back. `auth` is shared across requests because a
 * top-up mints a fresh account object that later requests should keep using.
 */
async function handleRequest(auth, req, res) {
  const path = req.url || '/'
  try {
    const isChat = path.includes('chat/completions')
    const { body, wantStream, primaryModel } = await readRequestBody(req, isChat)
    const sub = path.replace(/^\/v1\//, 'openrouter/')
    const ctx = {
      auth,
      method: req.method || 'POST',
      target: `${GATEWAY_ORIGIN}/v1/${sub}`,
      subPath: sub.replace(/^\//, ''),
      headers: {},
    }
    ctx.headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      ...(await prepaidHeaders(auth.account, ctx.subPath)),
    }
    console.error(
      `[x402-proxy] ${req.method} ${path} → ${ctx.target}${wantStream ? ' (stream→buffered)' : ''}`
    )

    const attempt = await runModelSequence(ctx, body, pickModelSequence(primaryModel, isChat), isChat)
    convertResponse(res, { ...attempt, wantStream })
  } catch (err) {
    console.error(`[x402-proxy] ERROR ${path}:`, err?.stack || err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  }
}

/** Local OpenAI-compatible proxy so the agent can talk to x402gate. */
export async function startProxy(port = 0) {
  const auth = await ensurePrepaid(0.05) // { account, client, balance }
  const server = createServer((req, res) => handleRequest(auth, req, res))
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  return { server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}/v1` }
}
