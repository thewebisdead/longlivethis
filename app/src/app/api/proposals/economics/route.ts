import { NextResponse } from 'next/server'
import { recordActualEconomics, listActualEconomics, actualEconomicsCount } from '@/lib/economics'

export const dynamic = 'force-dynamic'

/**
 * GET /api/proposals/economics — list the recorded actual outcomes for
 * implemented proposals (cost / recurring cost / benefit). Returns the records
 * plus a count.
 */
export async function GET() {
  try {
    const records = await listActualEconomics()
    return NextResponse.json({ records, count: actualEconomicsCount(records) })
  } catch (err) {
    console.error('proposals/economics GET failed:', err)
    return NextResponse.json({ error: 'economics store unavailable' }, { status: 503 })
  }
}

/**
 * POST /api/proposals/economics — record the ACTUAL outcome for an
 * implemented proposal, so the board can show an estimate-vs-actual
 * comparison. Admin action: a maintainer (or a deploy step) measures the real
 * cost and benefit once the feature has shipped and run. Recording replaces
 * the current actual values for that proposal.
 *
 * Body: {
 *   proposalId: number,
 *   actualCostUsdc?: number,
 *   actualRecurringCostUsdc?: number,
 *   actualBenefitUsdc?: number,
 *   note?: string
 * }
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const proposalId = body.proposalId
  if (typeof proposalId !== 'number' || !Number.isInteger(proposalId) || proposalId <= 0) {
    return NextResponse.json({ error: 'proposalId must be a positive integer' }, { status: 400 })
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  try {
    const record = await recordActualEconomics({
      proposalId,
      actualCostUsdc: num(body.actualCostUsdc),
      actualRecurringCostUsdc: num(body.actualRecurringCostUsdc),
      actualBenefitUsdc: num(body.actualBenefitUsdc),
      note: typeof body.note === 'string' ? body.note : undefined,
    })
    return NextResponse.json(record, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid economics record'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
