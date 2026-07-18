#!/usr/bin/env node
/**
 * Shared x402gate helpers for the agent (prepaid + per-request pay).
 * Deps (installed by agent.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createServer } from 'node:http'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'

export const X402GATE = (process.env.INFERENCE_BASE_URL || 'https://x402gate.io/v1/openrouter').replace(
  /\/$/,
  ''
)
export const GATEWAY_ORIGIN = X402GATE.includes('/v1/openrouter')
  ? X402GATE.replace(/\/v1\/openrouter$/, '')
  : 'https://x402gate.io'

function pk() {
  const raw = process.env.WALLET_PRIVATE_KEY?.trim()
  if (!raw) throw new Error('WALLET_PRIVATE_KEY is required')
  return /** @type {`0x${string}`} */ (raw.startsWith('0x') ? raw : `0x${raw}`)
}

function sanitizeAccept(accept) {
  const { price: _p, ...rest } = accept
  return rest
}

export function makeAccount() {
  return privateKeyToAccount(pk())
}

// --- Per-run spend cap: one run may spend at most HALF of the wallet's ------
// USDC balance at run start. Checked on-chain before every payment (top-up or
// per-request), so runaway loops — including anything malicious that reaches
// the local proxy — degrade the run instead of draining the wallet.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
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

/** Turn a non-streaming chat.completion into SSE chunks (Pi always requests stream:true). */
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

/** Model priority list (INFERENCE_MODEL, comma-separated in preference order).
 *  The proxy retries down the list when a model returns finish_reason=error /
 *  429 / 5xx (e.g. Gemini tool bugs). A single entry means no fallback. */
function modelCandidates(primary) {
  const list = (process.env.INFERENCE_MODEL || 'anthropic/claude-sonnet-4.6')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([primary, ...list].filter(Boolean))]
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

/** Local OpenAI-compatible proxy so Pi can talk to x402gate. */
export function startProxy(port = 0) {
  return new Promise(async (resolve, reject) => {
    let account, client
    try {
      ;({ account, client } = await ensurePrepaid(0.05))
    } catch (e) {
      reject(e)
      return
    }

    const server = createServer(async (req, res) => {
      const path = req.url || '/'
      try {
        const chunks = []
        for await (const c of req) chunks.push(c)
        let reqBody = Buffer.concat(chunks)
        let wantStream = false
        let primaryModel = (process.env.INFERENCE_MODEL || 'anthropic/claude-sonnet-4.6').split(',')[0].trim()
        if (reqBody.length && path.includes('chat/completions')) {
          try {
            const j = JSON.parse(reqBody.toString('utf8'))
            wantStream = !!j.stream
            if (j.model) primaryModel = j.model
            if (wantStream) {
              j.stream = false
              delete j.stream_options
              reqBody = Buffer.from(JSON.stringify(j))
            }
          } catch {
            /* leave body */
          }
        }
        const sub = path.replace(/^\/v1\//, 'openrouter/')
        const target = `${GATEWAY_ORIGIN}/v1/${sub}`
        const headers = {
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...(await prepaidHeaders(account, sub.replace(/^\//, ''))),
        }
        console.error(`[x402-proxy] ${req.method} ${path} → ${target}${wantStream ? ' (stream→buffered)' : ''}`)

        async function callUpstream(bodyBuf) {
          let upstream = await fetch(target, {
            method: req.method || 'POST',
            headers,
            body: bodyBuf.length ? bodyBuf : undefined,
          })
          if (upstream.status === 402 || upstream.status === 401 || upstream.status === 403) {
            console.error(`[x402-proxy] ${upstream.status} — paying / retrying…`)
            Object.assign(headers, await prepaidHeaders(account, sub.replace(/^\//, '')))
            upstream = await payAndRetry(
              target,
              {
                method: req.method || 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: bodyBuf.length ? bodyBuf : undefined,
              },
              client
            )
          }
          const text = await upstream.text()
          return { upstream, text, unwrapped: unwrapGateBody(text) }
        }

        const chat = path.includes('chat/completions')
        const candidates = chat ? modelCandidates(primaryModel) : [primaryModel]
        let upstream
        let text = ''
        let unwrapped = null
        let usedModel = primaryModel

        for (let i = 0; i < candidates.length; i++) {
          const model = candidates[i]
          const bodyBuf = chat ? bodyWithModel(reqBody, model) : reqBody
          if (model !== primaryModel) {
            console.error(`[x402-proxy] trying fallback model=${model}`)
          }

          ;({ upstream, text, unwrapped } = await callUpstream(bodyBuf))

          if ((upstream.ok && isFinishError(unwrapped)) || isRetryableHttp(upstream.status)) {
            console.error(
              `[x402-proxy] model=${model} ${summarizeCompletion(unwrapped, text)} — retrying once`
            )
            await new Promise((r) => setTimeout(r, 400))
            ;({ account } = await ensurePrepaid(0.05))
            Object.assign(headers, await prepaidHeaders(account, sub.replace(/^\//, '')))
            ;({ upstream, text, unwrapped } = await callUpstream(bodyBuf))
          }

          if (upstream.ok && isFinishError(unwrapped) && salvageFinishError(unwrapped)) {
            console.error(
              `[x402-proxy] salvaged finish_reason=error → ${unwrapped.choices[0].finish_reason} (model=${model})`
            )
            usedModel = model
            break
          }

          if (upstream.ok && !isFinishError(unwrapped)) {
            usedModel = model
            if (model !== primaryModel) {
              console.error(`[x402-proxy] fallback succeeded model=${model}`)
            }
            break
          }

          console.error(
            `[x402-proxy] model=${model} failed: status=${upstream.status} ${summarizeCompletion(unwrapped, text)}`
          )
          usedModel = model
        }

        if (!upstream.ok) {
          console.error(`[x402-proxy] upstream ${upstream.status}: ${text.slice(0, 800)}`)
        } else {
          console.error(
            `[x402-proxy] upstream ${upstream.status} model=${usedModel} (${text.length} bytes) ${summarizeCompletion(unwrapped, text)}`
          )
        }

        // Never hand Pi finish_reason=error — it aborts the whole agent run.
        if (upstream.ok && isFinishError(unwrapped)) {
          const choice = unwrapped.choices[0]
          choice.message = choice.message || { role: 'assistant', content: '' }
          if (!choice.message.content) {
            choice.message.content =
              'Provider returned an error on the last turn. Continue with the next tool or step.'
          }
          choice.finish_reason = 'stop'
          delete choice.native_finish_reason
          console.error(`[x402-proxy] forced stop after exhausted fallbacks (model=${usedModel})`)
        }

        if (wantStream && unwrapped?.choices) {
          res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream' })
          res.end(completionToSse(unwrapped))
          return
        }
        const out = unwrapped ? JSON.stringify(unwrapped) : text
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        })
        res.end(out)
      } catch (err) {
        console.error(`[x402-proxy] ERROR ${path}:`, err?.stack || err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err?.message || err) }))
      }
    })

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}/v1` })
    })
  })
}
