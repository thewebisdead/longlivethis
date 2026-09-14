#!/usr/bin/env node
/**
 * FROZEN — the local OpenAI-compatible proxy the agent buys inference through.
 *
 * Everything here is provider-NEUTRAL: model catalogue, stream→buffered
 * conversion, and the HTTP surface the agent talks to. Paying is the only part
 * that differs between gateways, and that lives behind the small adapter
 * interface in providers/index.mjs — so switching provider is a repo-variable
 * change (INFERENCE_PROVIDER / INFERENCE_BASE_URL), not a change to this file.
 *
 * The retry policy (model fallback, error salvage, waiting out a locked payment
 * channel) lives in retry.mjs, which imports nothing — so the frozen test can
 * exercise it without the x402 SDK or a wallet.
 *
 * Deps (installed by agent.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createServer } from 'node:http'
import { makeAccount } from '../lib/wallet.mjs'
import { initSpendCap } from './spend-cap.mjs'
import { resolveProvider } from './providers/index.mjs'
// Retry policy lives in retry.mjs so it can be tested without the x402 SDK or a
// wallet — see the header there.
import { classifyFailure, isFinishError, runModelSequence, summarizeCompletion } from './retry.mjs'

export { makeAccount }

/** Turn a non-streaming chat.completion into SSE chunks (the agent always requests stream:true). */
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
 * cannot actually reach. implement.sh builds the agent's provider config FROM
 * this endpoint, so the two cannot disagree.
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

/**
 * How long the agent is told to wait before re-asking, after a payment failure
 * this proxy could not retry away. Long enough that the agent is not hammering
 * a channel that needs minutes; short enough that a run with time left on the
 * clock gets several more goes.
 */
const PAYMENT_RETRY_AFTER_S = 30

/** Write the gateway's answer back to the agent (SSE when it asked to stream). */
function convertResponse(res, { upstream, text, unwrapped, usedModel, wantStream, terminal }) {
  if (!upstream.ok) {
    console.error(`[proxy] upstream ${upstream.status}: ${text.slice(0, 800)}`)
    // Log the headers first — a payment failure can carry an empty body ("{}")
    // with the gateway's actual reason only there — then restate it as a rate
    // limit before answering.
    //
    // The agent's client ends the WHOLE SESSION on a 402 (opencode marked it
    // `isRetryable: false`; Pi does not retry it either). An 18-minute run was
    // lost that way. 429 + Retry-After is the same fact in a shape the client
    // waits out instead of dying on, so the worst case is a run that goes round
    // in circles and produces nothing — never a run that fails. Pi honours the
    // Retry-After only because implement.sh turns on SDK-level retries — see
    // the retry policy it writes into settings.json.
    //
    // KEPT DELIBERATELY, against the gateway author's advice to drop it (Aug
    // 2026). Their argument — that `channel_busy` is a 503 now, so a surviving
    // 402 means a real payment action the agent should see — assumes the agent
    // could act on it. It cannot: by the time a 402 reaches here, the x402 SDK
    // has already tried the payment handshake and failed, so handing it through
    // buys no remedy and costs the run. This is a property of THIS client, not
    // of any gateway's taxonomy: it must hold for a gateway that regresses, for
    // x402gate, and for whatever pays for inference next. The diagnosis is not
    // lost — the code is logged right here and lands in the run summary.
    //
    // The rule is REWRITE WHAT CAN CLEAR, PASS THROUGH WHAT CANNOT. A wallet
    // that genuinely cannot pay is the second kind: retrying it burns the rest
    // of the implementation budget on requests guaranteed to be refused, so a
    // failure the provider adapter classifies as 'insufficient-funds' is handed
    // through as a fatal 402 on purpose — the run ends now, the job still goes
    // green (the workflow's continue-on-error), and the summary says why.
    // Flagged by the gateway author, Aug 2026. The local spend cap takes the
    // same path from handleRequest's catch.
    if (upstream.status === 402 && !terminal) {
      const why = unwrapped?.error?.code || '(gateway named no code)'
      console.error(`[proxy] 402 headers: ${JSON.stringify(Object.fromEntries(upstream.headers))}`)
      console.error(
        `[proxy] payment refused (${why}) — handing it back as 429 (Retry-After: ${PAYMENT_RETRY_AFTER_S}s) so the agent waits instead of ending the run`
      )
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(PAYMENT_RETRY_AFTER_S),
      })
      res.end(
        JSON.stringify({
          error: {
            message: `payment gateway unavailable (402) — retry in ${PAYMENT_RETRY_AFTER_S}s`,
            type: 'rate_limit_error',
          },
        })
      )
      return
    }
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
    // A gateway saying the wallet cannot pay is the one payment failure worth
    // ending the run over — see the 402 handling in convertResponse.
    const terminal =
      classifyFailure(run.session, attempt.upstream, attempt.unwrapped)?.kind === 'insufficient-funds'
    convertResponse(res, { ...attempt, wantStream, terminal })
  } catch (err) {
    console.error(`[proxy] ERROR ${path}:`, err?.stack || err)
    // Same rule as a terminal 402: an error that cannot clear (the spend cap
    // being reached) must not be answered with a status the agent's client
    // retries, or the rest of the implementation budget goes on requests that
    // are guaranteed to be refused. 402 is fatal to that client, which is
    // exactly what is wanted here — the run ends now, the job stays green, and
    // the summary says why.
    if (err?.terminal) {
      console.error(`[proxy] TERMINAL — ending the run rather than retrying: ${err.message}`)
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(err.message), type: 'insufficient_quota' } }))
      return
    }
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
