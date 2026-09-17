import { NextResponse } from 'next/server'
import { emergencyThresholdDays } from '@/lib/config'
import { getSurvivalInfo } from '@/lib/survival'

export const dynamic = 'force-dynamic'

/**
 * GET /api/survival-mode — current Emergency Survival Mode status.
 *
 * Returns the current survival mode level (normal / watch / emergency /
 * critical / paused), whether it is active, the policy in force, and tracking
 * counters (runs skipped / downshifted, cost-saving and revenue proposals
 * recorded). Read-only — no side effects.
 *
 * Shape:
 *   {
 *     level, label, active, policy, enteredAt,
 *     runsSkipped, runsDownshifted, costSavingProposals, revenueProposals,
 *     everBeenInEmergency, runwayDays, dailyBurn,
 *     emergencyThresholdDays
 *   }
 */
export async function GET() {
  const info = await getSurvivalInfo(emergencyThresholdDays)
  return NextResponse.json({ ...info, emergencyThresholdDays })
}
