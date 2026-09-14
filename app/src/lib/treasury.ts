// USDC balance on Base via a raw eth_call (balanceOf) — no web3 library.
import { baseRpcUrl } from './config.ts'
import { defineCache } from './cache.ts'

// Contract address is a fixed property of Base mainnet, not deployment config.
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BALANCE_OF_SELECTOR = '0x70a08231'

// The public RPC is rate-limited; one call per minute serves every visitor.
// Keyed on the account so a wallet rotation cannot serve the old balance.
// No stale-on-error: the homepage renders "…" when this rejects, which is
// honest about not knowing — a stale treasury figure is not.
const balanceCache = defineCache('treasury', 60_000, fetchUsdcBalance)

export function getUsdcBalance(address: string): Promise<number> {
  const account = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(account)) {
    return Promise.reject(new Error(`invalid address: ${address}`))
  }
  return balanceCache.get(account)
}

async function fetchUsdcBalance(account: string): Promise<number> {
  const res = await fetch(baseRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: USDC_ADDRESS, data: BALANCE_OF_SELECTOR + account.padStart(64, '0') }, 'latest'],
    }),
    cache: 'no-store',
    // The homepage awaits this server-side — never let a slow RPC hang renders.
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`RPC ${baseRpcUrl} failed: ${res.status}`)
  const { result, error } = (await res.json()) as { result?: string; error?: { message?: string } }
  if (error || typeof result !== 'string') throw new Error(`eth_call failed: ${error?.message ?? 'no result'}`)
  return Number(BigInt(result)) / 1e6 // USDC has 6 decimals
}
