#!/usr/bin/env node
/**
 * Self-contained x402Compute (Singularity Compute) client for the deployed repo.
 * Reads instance status (signed X402-COMPUTE-AUTH headers) and extends the prepaid
 * window (USDC on Base via x402). Used by renew-vps.mjs in the renew workflow.
 *
 * Deps (installed by renew.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createHash, randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { wrapFetchWithPayment, x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { ExactEvmSchemeV1 } from '@x402/evm/exact/v1/client'

export const API = (process.env.X402_COMPUTE_API || 'https://compute.x402layer.cc').replace(/\/$/, '')

function pk() {
  const raw = process.env.WALLET_PRIVATE_KEY?.trim()
  if (!raw) throw new Error('WALLET_PRIVATE_KEY is required')
  return /** @type {`0x${string}`} */ (raw.startsWith('0x') ? raw : `0x${raw}`)
}

/** x402 fetch registering v1 (extend uses x402Version:1, network "base") + v2 schemes. */
function paidFetch(account) {
  const client = new x402Client()
  client.register('eip155:*', new ExactEvmScheme(account))
  client.registerV1('eip155:*', new ExactEvmSchemeV1(account))
  client.register('eip155:8453', new ExactEvmScheme(account))
  client.registerV1('eip155:8453', new ExactEvmSchemeV1(account))
  client.registerV1('base', new ExactEvmSchemeV1(account))
  return wrapFetchWithPayment(fetch, client)
}

/** Signed read-auth headers (mirrors the initializer's signedAuthHeaders). */
async function authHeaders(account, method, path, body = '') {
  const address = account.address.toLowerCase()
  const timestampMs = Date.now()
  const nonce = randomUUID().replace(/-/g, '')
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const message = [
    'X402-COMPUTE-AUTH',
    'v1',
    'base',
    address,
    method.toUpperCase(),
    path,
    bodyHash,
    String(timestampMs),
    nonce,
  ].join('\n')
  const signature = await account.signMessage({ message })
  return {
    'X-Auth-Address': address,
    'X-Auth-Chain': 'base',
    'X-Auth-Signature': signature,
    'X-Auth-Timestamp': String(timestampMs),
    'X-Auth-Nonce': nonce,
    'X-Auth-Sig-Encoding': 'hex',
  }
}

function parseOrder(data) {
  const root = data || {}
  return root.order ?? root
}

/** Fetch instance detail (read-only, signed — no charge). Returns null if unavailable. */
export async function getInstance(account, instanceId) {
  const path = `/compute/instances/${instanceId}`
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: await authHeaders(account, 'GET', path),
  })
  const text = await res.text()
  if (!res.ok) return null
  try {
    return parseOrder(JSON.parse(text))
  } catch {
    return null
  }
}

/** Hours until expiry (negative if expired). null if unknown. */
export function hoursUntilExpiry(order, now = Date.now()) {
  if (!order?.expires_at) return null
  const expiry = Date.parse(order.expires_at)
  if (Number.isNaN(expiry)) return null
  return (expiry - now) / 3_600_000
}

/** Extend the prepaid window by one day (+24h). Pays USDC on Base via x402. */
export async function extendInstance(account, instanceId) {
  const path = `/compute/instances/${instanceId}/extend`
  const res = await paidFetch(account)(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`extend failed: ${res.status} ${raw.slice(0, 400)}`)
  let order = {}
  try {
    order = parseOrder(JSON.parse(raw))
  } catch {
    /* non-JSON success — still extended */
  }
  return { expiresAt: order.expires_at ?? null, amountUsdc: order.payment_amount ?? null }
}

export function makeAccount() {
  return privateKeyToAccount(pk())
}
