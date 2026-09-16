import { NextResponse } from 'next/server'
import { walletAddress } from '@/lib/config'
import { getUsdcBalance } from '@/lib/treasury'
import { getRunway } from '@/lib/runway'
import { decideRun } from '@/lib/spendGuard'
import { currentTriggerState } from '@/lib/agentTrigger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/spend-guard — the current guard decision, transparently.
 *
 * Returns the spend guard's assessed state: runway info, the guard's computed
 * decision (run / downshift / skip), and the last recorded trigger state from
 * the durable volume. This endpoint has no side effects — no dispatch, no
 * state mutation.
 *
 * Intended for observability: a visitor (or a future dashboard) can see
 * whether agent runs are being skipped and why.
 */
export async function GET() {
  let runway
  try {
    runway = await getRunway(
      () => (walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0)),
    )
  } catch {
    runway = null
  }

  const decision = runway ? decideRun(runway) : null
  const triggerState = await currentTriggerState()

  return NextResponse.json({
    available: runway != null,
    decision,
    runway,
    triggerState,
  })
}
