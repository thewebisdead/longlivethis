#!/usr/bin/env node
/**
 * Keep the x402Compute VPS alive by extending its prepaid window before it expires.
 * Runs on GitHub Actions (renew.yml) — the only place the wallet spend key lives.
 * Pure API + payment: no SSH, no redeploy, no DB touch. Same box, same IP, same data.
 *
 * Env:
 *   WALLET_PRIVATE_KEY          wallet that pays the extension (USDC on Base)
 *   X402_COMPUTE_INSTANCE_ID    instance to keep alive (empty => nothing to do)
 *   RENEW_MIN_HOURS   (12)      extend when fewer than this many hours remain
 *   RENEW_TARGET_HOURS (48)     extend until at least this many hours remain
 *   RENEW_MAX_EXTENDS (3)       hard per-run cap on paid extends (runaway-spend guard)
 */
import { makeAccount, getInstance, hoursUntilExpiry, extendInstance } from './x402compute.mjs'

const INSTANCE_ID = process.env.X402_COMPUTE_INSTANCE_ID?.trim()
const MIN_HOURS = Number(process.env.RENEW_MIN_HOURS || '12')
const TARGET_HOURS = Number(process.env.RENEW_TARGET_HOURS || '48')
const MAX_EXTENDS = Number(process.env.RENEW_MAX_EXTENDS || '3')

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`)
}

if (!INSTANCE_ID) {
  log('No X402_COMPUTE_INSTANCE_ID set — VPS is not on x402Compute; nothing to renew.')
  process.exit(0)
}
if (!(TARGET_HOURS > MIN_HOURS)) {
  console.error(`RENEW_TARGET_HOURS (${TARGET_HOURS}) must be greater than RENEW_MIN_HOURS (${MIN_HOURS}).`)
  process.exit(1)
}

const account = makeAccount()

let order = await getInstance(account, INSTANCE_ID)
if (!order) {
  console.error(`::error::Could not read instance ${INSTANCE_ID}. It may be destroyed — re-provision needed.`)
  process.exit(1)
}

let hoursLeft = hoursUntilExpiry(order)
if (hoursLeft === null) {
  console.error('::error::Instance has no expires_at — cannot determine renewal state.')
  process.exit(1)
}
log(`Instance ${INSTANCE_ID}: ${hoursLeft.toFixed(1)}h until expiry (status=${order.status ?? '?'}).`)

if (hoursLeft >= MIN_HOURS) {
  log(`Above ${MIN_HOURS}h threshold — no renewal needed.`)
  process.exit(0)
}

let extends_ = 0
let spent = 0
while (hoursLeft < TARGET_HOURS && extends_ < MAX_EXTENDS) {
  log(`Extending (+24h)… [${extends_ + 1}/${MAX_EXTENDS}]`)
  const { expiresAt, amountUsdc } = await extendInstance(account, INSTANCE_ID)
  extends_ += 1
  if (amountUsdc != null) spent += amountUsdc

  // Re-read to confirm the window actually advanced; stop if it didn't (avoid paying for nothing).
  order = (await getInstance(account, INSTANCE_ID)) ?? order
  const prev = hoursLeft
  hoursLeft = hoursUntilExpiry(order) ?? (expiresAt ? (Date.parse(expiresAt) - Date.now()) / 3_600_000 : prev)
  log(`  now ${hoursLeft.toFixed(1)}h until expiry.`)
  if (hoursLeft <= prev + 0.5) {
    console.error('::warning::Expiry did not advance after extend — stopping to avoid repeated charges.')
    break
  }
}

log(`Done: ${hoursLeft.toFixed(1)}h buffer after ${extends_} extend(s)${spent ? `, ~$${spent.toFixed(2)} USDC spent` : ''}.`)

if (hoursLeft < MIN_HOURS) {
  console.error(`::error::Still below ${MIN_HOURS}h after ${extends_} extend(s) — check wallet balance / provider.`)
  process.exit(1)
}
