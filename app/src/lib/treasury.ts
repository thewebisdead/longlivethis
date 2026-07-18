// USDC balance on Base via a raw eth_call (balanceOf) — no web3 library.
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BALANCE_OF_SELECTOR = '0x70a08231'
const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

// The public RPC is rate-limited; one call per minute serves every visitor.
// On globalThis because Next bundles this module per route — the page render
// and /api/treasury must share the cache (single Node process).
const CACHE_TTL_MS = 60_000
type BalanceCache = { account: string; balance: number; ts: number } | null
const g = globalThis as Record<string, unknown> & { __longliveTreasury?: BalanceCache }

export async function getUsdcBalance(address: string): Promise<number> {
  const account = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(account)) throw new Error(`invalid address: ${address}`)
  const cached = g.__longliveTreasury
  if (cached && cached.account === account && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.balance
  }
  const res = await fetch(RPC_URL, {
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
  if (!res.ok) throw new Error(`RPC ${RPC_URL} failed: ${res.status}`)
  const { result, error } = (await res.json()) as { result?: string; error?: { message?: string } }
  if (error || typeof result !== 'string') throw new Error(`eth_call failed: ${error?.message ?? 'no result'}`)
  const balance = Number(BigInt(result)) / 1e6 // USDC has 6 decimals
  g.__longliveTreasury = { account, balance, ts: Date.now() }
  return balance
}
