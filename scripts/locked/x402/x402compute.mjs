#!/usr/bin/env node
/**
 * Self-contained x402Compute (Singularity Compute) client for the deployed repo.
 * Reads instance status (signed X402-COMPUTE-AUTH headers) and extends the prepaid
 * window (USDC on Base via x402). Used by renew-vps.mjs in the renew workflow.
 *
 * Deps (installed by renew.yml): viem, @x402/fetch, @x402/evm, @x402/core
 */
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapFetchWithPayment, x402Client } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm'
import { ExactEvmSchemeV1 } from '@x402/evm/exact/v1/client'

export { makeAccount } from '../lib/wallet.mjs'

export const API = (process.env.X402_COMPUTE_API || 'https://compute.x402layer.cc').replace(/\/$/, '')

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

// ---------------------------------------------------------------------------
// Provisioning + fleet management — used by migrate-vps.mjs (the migrate
// workflow). Same trust boundary as renew: spend key lives only in Actions.
// ---------------------------------------------------------------------------

export function orderId(order) {
  return order?.id ?? order?.instance_id ?? order?.vultr_instance_id ?? order?.provider_instance_id
}

export function orderIp(order) {
  const ip = order?.ip_address ?? order?.ip ?? order?.main_ip ?? order?.ssh_host ?? ''
  if (!ip || ip === '0.0.0.0') return ''
  return ip
}

/** Plan id the box actually runs on (the API reports it as `vultr_plan`). */
export function orderPlanId(order) {
  return order?.vultr_plan ?? order?.plan ?? order?.plan_id ?? null
}

/** Box RAM in MB (the API reports it as `vultr_ram`). null when unreported. */
export function orderRam(order) {
  return Number(order?.vultr_ram ?? order?.ram) || null
}

/**
 * Is this box still running (and still being paid for)? `listInstances` returns
 * destroyed boxes too, so anything that acts on the fleet must filter on this
 * or it will re-destroy history.
 */
export function orderActive(order) {
  if (order?.destroyed_at) return false
  const status = order?.status ?? order?.vultr_status
  return status ? status === 'active' : true
}

/** All instances owned by the wallet (signed read — no charge). */
export async function listInstances(account) {
  const path = '/compute/instances'
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: await authHeaders(account, 'GET', path),
  })
  const text = await res.text()
  if (!res.ok) return []
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data)) return data
    return data.instances ?? data.orders ?? []
  } catch {
    return []
  }
}

/** Plans we will actually run on: standard Vultr VPS, no GPU / DigitalOcean / premium-optimized tiers. */
export function isEligiblePlan(p) {
  return !p.id.startsWith('do:') && !p.id.includes('gpu') && !p.id.includes('vcg') && !p.id.startsWith('voc-')
}

/** Daily USDC rate for a plan (prefers the API's our_daily, else hourly×24). */
export function planDaily(p) {
  return p?.our_daily ?? (p ? +(p.our_hourly * 24).toFixed(4) : null)
}

/** All plans from the provider (the raw catalog). */
export async function fetchPlans() {
  const res = await fetch(`${API}/compute/plans`)
  if (!res.ok) throw new Error(`Failed to list plans: ${res.status}`)
  const { plans } = await res.json()
  return plans
}

/**
 * Cheapest eligible plan with at least `minRamMb` (falls back to cheapest >=1GB).
 */
export async function pickPlan(minRamMb = 1024) {
  const plans = await fetchPlans()
  const byPrice = (a, b) => a.our_hourly - b.our_hourly
  const eligible = plans.filter((p) => isEligiblePlan(p) && p.ram >= minRamMb).sort(byPrice)
  if (eligible.length) return eligible[0]
  const tiny = plans.filter((p) => isEligiblePlan(p) && p.ram >= 1024).sort(byPrice)
  if (!tiny.length) throw new Error('No suitable x402Compute plans found')
  return tiny[0]
}

/** Poll until the instance has a routable IP (or timeout). */
export async function waitForInstanceIp(account, instanceId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const order = await getInstance(account, instanceId)
    const ip = orderIp(order)
    if (ip) return ip
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error(`Timed out waiting for IP on instance ${instanceId}`)
}

/** Key names the provider has been seen to use, plus plausible variants. */
const PASSWORD_KEYS = [
  'password',
  'root_password',
  'rootPassword',
  'default_password',
  'defaultPassword',
  'root_pass',
  'initial_password',
]

/** Depth-limited search for a password field — the provider may nest it (e.g. {data:{password}}). */
function findPassword(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return null
  for (const key of PASSWORD_KEYS) {
    if (typeof value[key] === 'string' && value[key].length > 0) return value[key]
  }
  for (const v of Object.values(value)) {
    const found = findPassword(v, depth + 1)
    if (found) return found
  }
  return null
}

/** Stash the raw reveal before anything can throw. Never throws itself. */
function stashPasswordResponse(instanceId, status, body) {
  try {
    const dir = process.env.RUNNER_TEMP || tmpdir()
    const file = join(dir, `password-reveal-${instanceId}-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify({ instanceId, status, body, at: new Date().toISOString() }, null, 2), {
      mode: 0o600,
    })
    return file
  } catch {
    return null
  }
}

/**
 * One-time root password for a fresh instance (signed POST — no charge).
 *
 * The reveal is ONE-SHOT: the provider does not store the password and refuses
 * to show it a second time ("If it is lost, redeploy the machine for a fresh
 * one"), so this response body is the only copy that will ever exist. Every
 * precaution below exists because an earlier version dropped it — it returned
 * null on both a non-2xx status and an unrecognised JSON shape, which is
 * indistinguishable from "no password available" and silently burned the reveal
 * on a paid, otherwise-unreachable box.
 *
 * Returns null if no password could be read; check stderr, because a null here
 * may mean the reveal was spent rather than never granted.
 */
export async function getPassword(account, instanceId) {
  const path = `/compute/instances/${instanceId}/password`
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: await authHeaders(account, 'POST', path),
  })
  const text = await res.text()

  // Stash first, parse second: whatever goes wrong below, the value survives.
  const stash = stashPasswordResponse(instanceId, res.status, text)

  if (!res.ok) {
    // Not necessarily harmless — a 409 means the reveal was already spent.
    console.error(`x402compute: password reveal failed (${res.status}): ${text.slice(0, 200)}`)
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    console.error(
      `x402compute: password reveal returned ${res.status} with non-JSON body — the reveal is now ` +
        `SPENT and cannot be repeated.${stash ? ` Raw body saved to ${stash}` : ` Raw body: ${text.slice(0, 400)}`}`
    )
    return null
  }

  const password = findPassword(parsed)
  if (!password) {
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).join(', ') : typeof parsed
    console.error(
      `x402compute: password reveal returned ${res.status} but no password field was found (keys: ${keys}). ` +
        `The reveal is now SPENT and cannot be repeated.${stash ? ` Raw body saved to ${stash} — read it before redeploying the box.` : ''}`
    )
    return null
  }

  return password
}

/**
 * Provision a fresh VPS (USDC on Base via x402). Mirrors the initializer's
 * provisionX402Compute. Returns { id, host, plan, prepaidHours, costUsdcApprox }.
 */
export async function provisionInstance(account, opts) {
  const prepaidHours = opts.prepaidHours ?? 24
  const plan = opts.plan ?? (await pickPlan(opts.minRamMb ?? 1024))
  const region = opts.region ?? plan.locations?.find((l) => l === 'ams') ?? plan.locations?.[0] ?? 'ewr'
  const body = JSON.stringify({
    plan: plan.id,
    region,
    os_id: 1743,
    label: opts.label ?? 'longlive',
    prepaid_hours: prepaidHours,
    ssh_public_key: opts.sshPublicKey,
    network: 'base',
  })
  const res = await paidFetch(account)(`${API}/compute/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`provision failed: ${res.status} ${raw.slice(0, 400)}`)
  const order = parseOrder(JSON.parse(raw))
  const id = orderId(order)
  if (!id) throw new Error(`provision response missing id: ${raw.slice(0, 400)}`)
  let host = orderIp(order)
  if (!host) host = await waitForInstanceIp(account, id)
  return {
    id,
    host,
    plan: order.plan ?? plan.id,
    ram: plan.ram,
    prepaidHours: order.prepaid_hours ?? prepaidHours,
    costUsdcApprox: order.payment_amount ?? +(plan.our_hourly * prepaidHours).toFixed(2),
  }
}

/** Best-effort teardown of the OLD box after cutover. Never throws — if it fails, the prepaid window lapses on its own. */
export async function destroyInstance(account, instanceId) {
  try {
    const path = `/compute/instances/${instanceId}`
    const res = await fetch(`${API}${path}`, {
      method: 'DELETE',
      headers: await authHeaders(account, 'DELETE', path),
    })
    return res.ok
  } catch {
    return false
  }
}
