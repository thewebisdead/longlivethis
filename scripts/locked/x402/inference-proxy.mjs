#!/usr/bin/env node
/**
 * FROZEN — the local OpenAI-compatible proxy the agent buys inference through.
 *
 * Everything here is provider-NEUTRAL: model catalogue, stream→buffered
 * conversion, model fallback, error salvage. Paying is the only part that
 * differs between gateways, and that lives behind the small adapter interface
 * in providers/index.mjs — so switching provider is a repo-variable change
 * (INFERENCE_PROVIDER / INFERENCE_BASE_URL), not a change to this file.
 *
 * Deps (installed by agent.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createServer } from 'node:http'
import { makeAccount } from '../lib/wallet.mjs'
import { initSpendCap } from './spend-cap.mjs'
import { resolveProvider } from './providers/index.mjs'

export { makeAccount }

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
        '(e.g. deepseek/deepseek-v4-flash-latest), optionally a comma-separated fallback list.'
    )
  }
  return models
}

/**
 * OpenAI-shaped catalogue for GET /v1/models, served locally rather than
 * forwarded. Answering from INFERENCE_MODEL is the honest answer whatever the
 * gateway would list: that variable is exactly the set of ids this proxy will
 * route and pay for, so anything else it reported would be a model the agent
 * cannot actually reach. Same source as the opencode provider config written by
 * implement.sh, so the two never disagree.
 */
function modelsCatalogue(providerId) {
  const created = Math.floor(Date.now() / 1000)
  return configuredModels().map((id) => ({
    id,
    object: 'model',
    created,
    owned_by: providerId,
  }))
}

/**
 * Answer /v1/models and /v1/models/<id> when the request is one of those,
 * and report whether it was handled. Model ids contain slashes
 * (`deepseek/deepseek-v4-flash-latest`), so the single-model form is everything
 * after `models/`.
 */
function serveModels(req, res, path, providerId) {
  const [clean] = String(path).split('?')
  const m = clean.replace(/^\/+/, '').replace(/^v1\//, '')
  if ((req.method || 'GET') !== 'GET' || (m !== 'models' && !m.startsWith('models/'))) return false
  req.resume() // drain any body so the socket is not left half-read
  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const data = modelsCatalogue(providerId)
  if (m === 'models') {
    json(200, { object: 'list', data })
    return true
  }
  const id = m.slice('models/'.length).replace(/\/+$/, '')
  const hit = data.find((e) => e.id === id)
  if (hit) json(200, hit)
  else json(404, { error: { message: `model ${id} not configured`, type: 'invalid_request_error' } })
  return true
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
 * Try one model. A provider error (finish_reason=error, 429, 5xx) is retried
 * once against the SAME model after the session refreshes whatever it needs
 * (a prepaid top-up, a channel deposit) — these are usually transient. Returns
 * the last attempt.
 */
async function tryUpstream(ctx, bodyBuf, model) {
  let result = await callUpstream(ctx, bodyBuf)
  const { upstream, text, unwrapped } = result
  if ((upstream.ok && isFinishError(unwrapped)) || isRetryableHttp(upstream.status)) {
    console.error(`[proxy] model=${model} ${summarizeCompletion(unwrapped, text)} — retrying once`)
    await new Promise((r) => setTimeout(r, 400))
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
async function runModelSequence(ctx, reqBody, candidates, isChat) {
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
  }
  return { ...result, usedModel }
}

/** Write the gateway's answer back to the agent (SSE when it asked to stream). */
function convertResponse(res, { upstream, text, unwrapped, usedModel, wantStream }) {
  if (!upstream.ok) {
    console.error(`[proxy] upstream ${upstream.status}: ${text.slice(0, 800)}`)
  } else {
    console.error(
      `[proxy] upstream ${upstream.status} model=${usedModel} (${text.length} bytes) ${summarizeCompletion(unwrapped, text)}`
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
    console.error(`[proxy] forced stop after exhausted fallbacks (model=${usedModel})`)
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
 * sequence, write the answer back. `run` carries the provider, its base URL and
 * the live session, all shared across requests.
 */
async function handleRequest(run, req, res) {
  const path = req.url || '/'
  try {
    // The catalogue is answered here, not upstream, and costs nothing.
    if (serveModels(req, res, path, run.provider.id)) {
      console.error(`[proxy] ${req.method} ${path} → served locally`)
      return
    }
    const isChat = path.includes('chat/completions')
    const { body, wantStream, primaryModel } = await readRequestBody(req, isChat)
    const ctx = {
      session: run.session,
      method: req.method || 'POST',
      path,
      target: run.provider.targetUrl(run.baseUrl, path),
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
    }
    console.error(
      `[proxy] ${req.method} ${path} → ${ctx.target}${wantStream ? ' (stream→buffered)' : ''}`
    )

    const attempt = await runModelSequence(ctx, body, pickModelSequence(primaryModel, isChat), isChat)
    convertResponse(res, { ...attempt, wantStream })
  } catch (err) {
    console.error(`[proxy] ERROR ${path}:`, err?.stack || err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  }
}

/**
 * Start the local OpenAI-compatible proxy. Returns the server, its port, the
 * base URL the agent talks to, and `close()` — which shuts the listener down
 * and lets the provider settle up (a batch-settlement refund, say). Callers
 * MUST invoke close() at the end of the run; x402-proxy.mjs wires it to
 * SIGTERM/SIGINT.
 */
export async function startProxy(port = 0) {
  const { provider, baseUrl } = resolveProvider()
  const account = makeAccount()
  await initSpendCap(account)
  console.error(`[proxy] provider=${provider.id} base=${baseUrl}`)
  const session = await provider.open({ account, baseUrl })
  const run = { provider, baseUrl, session }

  const server = createServer((req, res) => handleRequest(run, req, res))
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  return {
    server,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    provider: provider.id,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await session.close()
    },
  }
}
