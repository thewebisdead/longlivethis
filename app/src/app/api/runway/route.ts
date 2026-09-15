import { NextResponse } from 'next/server'
import { walletAddress } from '@/lib/config'
import { getUsdcBalance } from '@/lib/treasury'
import { getRunway } from '@/lib/runway'

export const dynamic = 'force-dynamic'

// GET /api/runway — expose the current runway so a client can render the
// "N days left" readout and any consumer (or a future agent-side reader) can
// gate spend on the remaining treasury.
//
// Shape:
//   {
//     treasuryBalance, dailyBurn, runwayDays, runsInWindow,
//     totalBurnInWindow, level, policy
//   }
//
// When the treasury is unreadable (no wallet configured, RPC down) the ledger
// still returns and the runway is computed against balance 0 — which yields a
// paused state. That is the honest "we cannot afford/serve anymore" reading
// rather than erroring the page.
export async function GET() {
  const runway = await getRunway(() =>
    walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0)
  )
  return NextResponse.json(runway)
}
