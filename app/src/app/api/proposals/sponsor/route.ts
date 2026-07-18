import { NextResponse } from 'next/server'
import { listProposals, sponsorProposal } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = (process.env.WALLET_ADDRESS ?? '').toLowerCase()
const RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

// USDC on Base (6 decimals)
const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Verify that a given transaction hash contains a USDC Transfer event
 * on Base with:
 *   - to = WALLET_ADDRESS
 *   - value >= minAmount (in USDC, 6-decimal units)
 *
 * Returns the transferred amount in USDC, or throws if verification fails.
 */
async function verifyUsdcTransfer(txHash: string, minAmount: number): Promise<number> {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('invalid tx hash format')

  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`RPC error: ${res.status}`)

  const { result, error } = (await res.json()) as {
    result?: {
      status?: string
      logs?: Array<{
        address: string
        topics: string[]
        data: string
      }>
    } | null
    error?: { message?: string }
  }

  if (error) throw new Error(`eth_getTransactionReceipt failed: ${error.message ?? 'unknown'}`)
  if (!result) throw new Error('transaction not found or not yet mined')
  if (result.status === '0x0') throw new Error('transaction reverted')

  const logs = result.logs ?? []

  // Find a USDC Transfer log addressed to WALLET_ADDRESS
  const walletTopic = '0x' + WALLET_ADDRESS.replace(/^0x/, '').padStart(64, '0')

  for (const log of logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS) continue
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue
    if (log.topics[2]?.toLowerCase() !== walletTopic) continue

    // data is the uint256 value (32 bytes, no padding issues)
    const value = Number(BigInt(log.data)) / 1e6
    if (value < minAmount) {
      throw new Error(
        `transfer amount ${value.toFixed(6)} USDC is less than required ${minAmount.toFixed(6)} USDC`
      )
    }
    return value
  }

  throw new Error(
    `no USDC Transfer to ${WALLET_ADDRESS} found in transaction — ` +
      'ensure you sent USDC on Base to the correct address'
  )
}

/**
 * POST /api/proposals/sponsor
 * Body: { id: number, txHash: string }
 *
 * Verifies an on-chain USDC Transfer to WALLET_ADDRESS on Base (via
 * eth_getTransactionReceipt log inspection), then marks the proposal as
 * sponsored. Payment is provably bound to the request — no honour system.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    id?: unknown
    txHash?: unknown
  } | null

  const id = typeof body?.id === 'number' ? body.id : null
  const txHash = typeof body?.txHash === 'string' ? body.txHash.trim() : null

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (!txHash) return NextResponse.json({ error: 'txHash required' }, { status: 400 })

  if (!WALLET_ADDRESS) {
    return NextResponse.json({ error: 'wallet not configured' }, { status: 503 })
  }

  try {
    const proposals = await listProposals()
    const proposal = proposals.find((p) => p.id === id)
    if (!proposal) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    if (proposal.sponsored) {
      return NextResponse.json({ error: 'proposal is already sponsored' }, { status: 409 })
    }

    // Compute the required sponsor cost: 10% of current treasury balance.
    const balance = await getUsdcBalance(WALLET_ADDRESS).catch(() => null)
    const cost = balance !== null ? Math.max(balance * 0.1, 0) : 0

    // Verify the on-chain payment before applying the label.
    await verifyUsdcTransfer(txHash, cost)

    await sponsorProposal(id)
    return NextResponse.json({ ok: true, cost })
  } catch (err) {
    console.error('sponsor POST failed:', err)
    const message = err instanceof Error ? err.message : 'sponsor failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
