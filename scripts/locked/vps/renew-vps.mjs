#!/usr/bin/env node
/**
 * Keep the x402Compute VPS alive by extending its prepaid window before it expires.
 * Runs on GitHub Actions (renew.yml, every 6h) — the only place the wallet spend
 * key lives. Pure API + payment: no SSH, no redeploy, no DB touch. Same box, same
 * IP, same data.
 *
 * This is the ONLY thing that renews a box. Fresh boxes are bought with one
 * prepaid day and handed straight to this cron rather than topped up at birth: a
 * day bought pre-cutover is a day of exposure on a box that may be replaced hours
 * later, and it is this loop that has to work anyway.
 *
 * Corollary worth knowing: nothing renews a box that X402_COMPUTE_INSTANCE_ID no
 * longer names, so a box left behind by a failed migration lapses on its own
 * within a day. There is no orphan sweep, deliberately.
 *
 * Env:
 *   WALLET_PRIVATE_KEY          wallet that pays the extension (USDC on Base)
 *   X402_COMPUTE_INSTANCE_ID    instance to keep alive (empty => nothing to do)
 */
import { makeAccount, getInstance, hoursUntilExpiry, extendInstance } from '../x402/x402compute.mjs'
import { log } from '../lib/log.mjs'
import { PREPAID_HOURS, RENEW_BELOW_HOURS, SETTLE_SLACK_HOURS } from '../lib/constants.mjs'

const INSTANCE_ID = process.env.X402_COMPUTE_INSTANCE_ID?.trim()

if (!INSTANCE_ID) {
  log('No X402_COMPUTE_INSTANCE_ID set — VPS is not on x402Compute; nothing to renew.')
  process.exit(0)
}

function die(msg) {
  console.error(`::error::${msg}`)
  process.exit(1)
}

const account = makeAccount()
const order = await getInstance(account, INSTANCE_ID)
if (!order) die(`Could not read instance ${INSTANCE_ID}. It may be destroyed — re-provision needed.`)

const hoursLeft = hoursUntilExpiry(order)
if (hoursLeft === null) die(`Instance ${INSTANCE_ID} has no expires_at — cannot determine renewal state.`)
log(`Instance ${INSTANCE_ID}: ${hoursLeft.toFixed(1)}h until expiry (status=${order.status ?? '?'}).`)

if (hoursLeft >= RENEW_BELOW_HOURS - SETTLE_SLACK_HOURS) {
  log(`Above the ${RENEW_BELOW_HOURS}h mark — nothing to buy.`)
  process.exit(0)
}

// Exactly one prepaid day per run, and that IS the runaway-spend guard: the cron
// fires four times a day, so the box can never cost more than it consumes, and a
// backlog (a long outage, a wallet that was empty) is worked off a day per run
// rather than in one unbounded burst.
log(`Below ${RENEW_BELOW_HOURS}h — buying one more prepaid day…`)
const { expiresAt, amountUsdc } = await extendInstance(account, INSTANCE_ID)

const reread = (await getInstance(account, INSTANCE_ID)) ?? order
const after =
  hoursUntilExpiry(reread) ?? (expiresAt ? (Date.parse(expiresAt) - Date.now()) / 3_600_000 : hoursLeft)
log(`Now ${after.toFixed(1)}h until expiry${amountUsdc != null ? `, ~$${amountUsdc.toFixed(2)} USDC spent` : ''}.`)

// A window that did not move means we paid for nothing. Fail loudly rather than
// let the next cron pay again, four times a day, while the box expires anyway.
if (after <= hoursLeft + SETTLE_SLACK_HOURS) {
  die(
    `Expiry did not advance after a paid extend (${hoursLeft.toFixed(1)}h → ${after.toFixed(1)}h) — ` +
      `check the provider before it charges again.`
  )
}
if (after < PREPAID_HOURS - SETTLE_SLACK_HOURS) {
  log(`::warning:: Only ${after.toFixed(1)}h after an extend — the next run will buy another day.`)
}
