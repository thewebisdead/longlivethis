import { NextResponse } from 'next/server'
import {
  listRevenueProposals,
  createRevenueProposal,
  setRevenueStatus,
  validateRevenueProposal,
  revenueSummary,
} from '@/lib/revenue'

export const dynamic = 'force-dynamic'

/**
 * GET /api/revenue — list all revenue propositions (funding opportunities).
 *
 * Returns:
 *   {
 *     proposals: RevenueProposal[],
 *     summary: { openTargetUsdc, openCount, fundedCount, totalTargetUsdc }
 *   }
 */
export async function GET() {
  try {
    const proposals = await listRevenueProposals()
    const summary = revenueSummary(proposals)
    return NextResponse.json({ proposals, summary })
  } catch (err) {
    console.error('revenue GET failed:', err)
    return NextResponse.json({ error: 'revenue store unavailable' }, { status: 503 })
  }
}

/**
 * POST /api/revenue — add a new revenue proposition.
 *
 * Body:
 *   { type, title, description, targetUsdc, minUsdc? }
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const type = body.type
  const title = body.title
  const description = body.description
  const targetUsdc = body.targetUsdc
  const minUsdc = body.minUsdc

  // Validate types
  if (typeof type !== 'string') {
    return NextResponse.json({ error: 'type required' }, { status: 400 })
  }
  if (typeof title !== 'string') {
    return NextResponse.json({ error: 'title required' }, { status: 400 })
  }
  if (typeof description !== 'string') {
    return NextResponse.json({ error: 'description required' }, { status: 400 })
  }
  if (typeof targetUsdc !== 'number') {
    return NextResponse.json({ error: 'targetUsdc required' }, { status: 400 })
  }

  try {
    const proposal = await createRevenueProposal({
      type: type as never,
      title,
      description,
      targetUsdc,
      minUsdc: typeof minUsdc === 'number' ? minUsdc : undefined,
    })
    return NextResponse.json(proposal, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid proposal'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

/**
 * PATCH /api/revenue — update a revenue proposition's status.
 *
 * Body: { id: number, status: 'open' | 'claimed' | 'funded' }
 */
export async function PATCH(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const rawId = body.id
  const status = body.status
  if (typeof rawId !== 'number') {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }
  if (status !== 'open' && status !== 'claimed' && status !== 'funded') {
    return NextResponse.json({ error: 'status must be open, claimed or funded' }, { status: 400 })
  }

  try {
    const updated = await setRevenueStatus(rawId, status)
    if (!updated) {
      return NextResponse.json({ error: 'proposal not found' }, { status: 404 })
    }
    return NextResponse.json(updated)
  } catch (err) {
    console.error('revenue PATCH failed:', err)
    return NextResponse.json({ error: 'update failed' }, { status: 503 })
  }
}
