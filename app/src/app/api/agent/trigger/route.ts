import { NextResponse } from 'next/server'
import { runGuardedTrigger } from '@/lib/agentTrigger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/trigger — run the guarded agent trigger.
 *
 * This is the app's "run now" seam. It evaluates the spend guard against the
 * current runway and dispatches agent.yml only when the guard allows:
 *   - safe/reduced runway → dispatch (mode "run")
 *   - critical runway      → dispatch but flagged "downshift"
 *   - paused runway        → refuse (409) — no dispatch, no spend
 *
 * The response carries the guard's decision and whether a dispatch happened,
 * so the caller (the background self-trigger, or a future UI) can tell skip
 * from run apart.
 *
 * The cadence is enforced in-app (see agentTrigger.ts), so repeated POSTs
 * within the cadence window are throttled to a no-op (200, throttled: true)
 * rather than firing runs every request.
 */
export async function POST() {
  const result = await runGuardedTrigger()
  const status = result.decision.mode === 'skip' ? 409 : 200
  return NextResponse.json(result, { status })
}
