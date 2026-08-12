/**
 * FROZEN — per-run spend cap, shared by every inference provider.
 *
 * One run may spend at most HALF of the wallet's USDC balance at run start.
 * The floor is read once, then re-checked on chain before every payment, so a
 * runaway loop — including anything malicious that reaches the local proxy —
 * degrades the run instead of draining the wallet.
 *
 * Provider-agnostic on purpose: the cap is a property of the wallet, not of
 * whichever gateway is currently being paid, so swapping providers must never
 * be a way to lose it.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { USDC_BASE } from '../lib/constants.mjs'

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
let cached = { at: 0, balance: null }

/** Read the run-start balance and fix this run's floor at half of it. */
export async function initSpendCap(account) {
  if (spendFloorUsd !== null) return
  try {
    const bal = await walletUsdc(account.address)
    capAddress = account.address
    spendFloorUsd = bal / 2
    console.error(`[spend-cap] wallet $${bal.toFixed(2)} USDC — this run stops paying below $${spendFloorUsd.toFixed(2)}`)
  } catch (e) {
    // Fail open (like the run cooldown): an RPC hiccup must not kill the loop.
    console.error(`[spend-cap] warning: could not read wallet balance: ${e?.message || e}`)
  }
}

/**
 * Throw when this run has already spent down to the floor.
 *
 * Called before every request that MIGHT pay. Under a channel-based scheme
 * (batch-settlement) most requests spend from an existing deposit rather than
 * moving USDC, so the balance rarely changes between two calls — the reading is
 * cached for CACHE_MS to keep a per-request check from becoming a per-request
 * RPC round trip. The cap is a runaway-loop guard, not an exact accountant, and
 * a few seconds of staleness costs at most a few requests' worth of spend.
 */
const CACHE_MS = 15_000

export async function assertSpendAllowed() {
  if (spendFloorUsd === null) return
  let bal = cached.balance
  if (bal === null || Date.now() - cached.at > CACHE_MS) {
    try {
      bal = await walletUsdc(capAddress)
      cached = { at: Date.now(), balance: bal }
    } catch {
      return // fail open on RPC errors; the cap re-checks on the next payment
    }
  }
  if (bal < spendFloorUsd) {
    throw new Error(
      `spend cap reached: wallet $${bal.toFixed(2)} USDC is below half of the run-start balance ($${spendFloorUsd.toFixed(2)}) — refusing further payments this run`
    )
  }
}

/** Drop the cached balance so the next check re-reads the chain. */
export function invalidateSpendCache() {
  cached = { at: 0, balance: null }
}
