import { NextResponse } from 'next/server'
import { listProposals, sponsorProposal } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? ''

/**
 * POST /api/proposals/sponsor
 * Body: { id: number }
 *
 * Marks a proposal as sponsored (adds the "sponsored" GitHub label),
 * which boosts it to the top of the feed. The cost is 10% of the current
 * treasury balance — shown in the UI before confirmation, enforced here
 * by verifying the label hasn't already been applied.
 *
 * Actual payment is handled client-side (USDC on Base); this endpoint
 * only applies the label once called. The receive-only constraint means
 * we cannot verify the payment on-chain here — sponsoring is honour-based
 * and the cost is displayed to the user before they confirm.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null
  const id = typeof body?.id === 'number' ? body.id : null
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  try {
    const proposals = await listProposals()
    const proposal = proposals.find((p) => p.id === id)
    if (!proposal) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    if (proposal.sponsored) {
      return NextResponse.json({ error: 'proposal is already sponsored' }, { status: 409 })
    }

    // Compute the sponsor cost: 10% of current treasury balance.
    const balance = WALLET_ADDRESS ? await getUsdcBalance(WALLET_ADDRESS).catch(() => null) : null
    const cost = balance !== null ? Math.max(balance * 0.1, 0) : null

    await sponsorProposal(id)
    return NextResponse.json({ ok: true, cost })
  } catch (err) {
    console.error('sponsor POST failed:', err)
    const message = err instanceof Error ? err.message : 'sponsor failed'
    return NextResponse.json({ error: message }, { status: 503 })
  }
}
