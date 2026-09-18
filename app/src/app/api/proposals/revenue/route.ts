import { NextResponse } from 'next/server'
import { recordProposalRevenue, listProposalRevenue, totalAttributedRevenue } from '@/lib/revenueProposal'

export const dynamic = 'force-dynamic'

/**
 * GET /api/proposals/revenue — list revenue attributed to implemented revenue
 * proposals.
 *
 * Returns: { records: RevenueRecord[], totalUsdc: number }
 */
export async function GET() {
  try {
    const records = await listProposalRevenue()
    return NextResponse.json({ records, totalUsdc: totalAttributedRevenue(records) })
  } catch (err) {
    console.error('proposals/revenue GET failed:', err)
    return NextResponse.json({ error: 'revenue attribution store unavailable' }, { status: 503 })
  }
}

/**
 * POST /api/proposals/revenue — record that an implemented proposal generated
 * a given amount of USDC. Admin action: attributes a treasury inflow to a
 * proposal. Amounts accumulate per proposal.
 *
 * Body: { proposalId: number, amountUsdc: number, note?: string }
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const proposalId = body.proposalId
  const amountUsdc = body.amountUsdc
  if (typeof proposalId !== 'number') {
    return NextResponse.json({ error: 'proposalId required' }, { status: 400 })
  }
  if (typeof amountUsdc !== 'number') {
    return NextResponse.json({ error: 'amountUsdc required' }, { status: 400 })
  }
  const note = typeof body.note === 'string' ? body.note : undefined
  try {
    const record = await recordProposalRevenue({ proposalId, amountUsdc, note })
    return NextResponse.json(record, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid revenue record'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
