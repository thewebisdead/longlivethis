/**
 * FROZEN — x402gate.io adapter (the previous default, kept as an alternative).
 *
 * Payment scheme: a prepaid balance held by the gateway. The wallet tops that
 * balance up with an x402 `exact` payment on Base, and each request carries
 * EIP-191 prepaid headers instead of a payment. Requests that come back 402 /
 * 401 / 403 pay and retry.
 *
 * Select it with INFERENCE_PROVIDER=x402gate (or by pointing
 * INFERENCE_BASE_URL at x402gate.io).
 */
import { x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { assertSpendAllowed, invalidateSpendCache } from '../spend-cap.mjs'

/** Minimum prepaid balance kept on the gateway, in USD. */
const MIN_PREPAID_USD = 0.05

/**
 * Split the base URL into the gateway root (which serves the account endpoints
 * /v1/balance and /v1/topup) and the provider prefix that sits between `/v1/`
 * and the OpenAI path.
 *
 *   https://x402gate.io/v1/openrouter → root https://x402gate.io, prefix openrouter
 *   https://gw.example/v1            → root https://gw.example,  prefix ''
 *   https://gw.example/api           → root https://gw.example/api, prefix ''
 */
function splitBase(baseUrl) {
  const i = baseUrl.indexOf('/v1/')
  if (i !== -1) {
    return { root: baseUrl.slice(0, i), prefix: baseUrl.slice(i + 4).replace(/^\/+|\/+$/g, '') }
  }
  if (baseUrl.endsWith('/v1')) return { root: baseUrl.slice(0, -3).replace(/\/+$/, ''), prefix: '' }
  return { root: baseUrl, prefix: '' }
}

/** Map a local proxy path (`/v1/chat/completions`) onto the gateway's sub-path. */
function subPathOf(baseUrl, path) {
  const { prefix } = splitBase(baseUrl)
  const rest = String(path).replace(/^\/+/, '').replace(/^v1\//, '')
  return prefix ? `${prefix}/${rest}` : rest
}

function targetUrl(baseUrl, path) {
  return `${splitBase(baseUrl).root}/v1/${subPathOf(baseUrl, path)}`
}

function sanitizeAccept(accept) {
  const { price: _p, ...rest } = accept
  return rest
}

function makeClient(account) {
  const client = new x402Client()
  client.register('eip155:8453', new ExactEvmScheme(account))
  client.register('eip155:*', new ExactEvmScheme(account))
  return client
}

/** Pay a 402 from the gateway and return the paid Response. */
async function payAndRetry(url, init, client) {
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

/** Prepaid balance for address (held on the gateway). */
async function getPrepaidBalance(root, address) {
  const r = await fetch(`${root}/v1/balance/${address}`)
  if (!r.ok) return 0
  const j = await r.json()
  return parseFloat(j.balance || '0') || 0
}

/** Top up the prepaid balance (USDC on Base). amount in USD. */
async function topUpPrepaid(root, client, amountUsd = 0.5) {
  await assertSpendAllowed()
  const res = await payAndRetry(
    `${root}/v1/topup`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amountUsd }) },
    client
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`topup failed: ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** EIP-191 prepaid headers for a path like openrouter/chat/completions. */
async function prepaidHeaders(account, subPath) {
  const ts = Math.floor(Date.now() / 1000)
  const signature = await account.signMessage({ message: `x402gate:${subPath}:${ts}` })
  return {
    'X-PREPAID-PUBKEY': account.address,
    'X-PREPAID-SIGNATURE': signature,
    'X-PREPAID-TIMESTAMP': String(ts),
  }
}

async function ensurePrepaid(root, account, client, minUsd = MIN_PREPAID_USD) {
  let bal = await getPrepaidBalance(root, account.address)
  if (bal < minUsd) {
    console.error(`[x402gate] prepaid balance $${bal} < $${minUsd} — topping up…`)
    const result = await topUpPrepaid(root, client, Math.max(0.5, minUsd))
    bal = parseFloat(result.balance || '0')
    console.error(`[x402gate] prepaid balance now $${bal}`)
  }
  return bal
}

export const x402gate = {
  id: 'x402gate',
  defaultBaseUrl: 'https://x402gate.io/v1/openrouter',
  hosts: ['x402gate.io'],
  targetUrl,

  async open({ account, baseUrl }) {
    const { root } = splitBase(baseUrl)
    const client = makeClient(account)
    await ensurePrepaid(root, account, client)

    return {
      // `path` is the request's local proxy path; the prepaid signature covers
      // the gateway sub-path it maps onto, so it is signed rather than derived
      // back out of the target URL.
      async fetch(url, init, path) {
        const sub = subPathOf(baseUrl, path)
        const headers = { ...(init.headers || {}), ...(await prepaidHeaders(account, sub)) }
        let res = await fetch(url, { ...init, headers })
        if (res.status === 402 || res.status === 401 || res.status === 403) {
          console.error(`[x402gate] ${res.status} — paying / retrying…`)
          res = await payAndRetry(
            url,
            { ...init, headers: { 'Content-Type': 'application/json', ...(await prepaidHeaders(account, sub)) } },
            client
          )
        }
        return res
      },

      /** Before a retry: put the prepaid balance back above the floor. */
      async refresh() {
        invalidateSpendCache()
        await ensurePrepaid(root, account, client)
      },

      /** Nothing to reclaim: the prepaid balance persists across runs. */
      async close() {},
    }
  },
}
