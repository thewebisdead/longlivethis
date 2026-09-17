import { NextResponse } from 'next/server'
import { listProposals } from '@/lib/github'
import { readLedger, summarize } from '@/lib/ledger'
import { getMilestoneTimeline } from '@/lib/milestones'
import type { MilestoneStats } from '@/lib/milestones'

export const dynamic = 'force-dynamic'

/**
 * GET /api/milestones — current survival milestones timeline.
 *
 * Returns the app's age, all defined milestones with their achievement status,
 * and the counts. Side-effect: evaluates milestones against current stats and
 * records any newly-crossed ones, so the timeline is always live.
 *
 * Shape:
 *   {
 *     ageDays: number,
 *     milestones: [{ def, value, achieved, achievedAt }],
 *     achievedCount, totalCount, bornAt
 *   }
 */
export async function GET() {
  const [proposals, ledger] = await Promise.all([
    listProposals().catch(() => []),
    readLedger().then(summarize).catch(() => ({
      state: { entries: [], lastBalanceUsdc: null },
      totalRunCostUsdc: 0,
      totalTransferredUsdc: 0,
      balanceUsdc: 0,
    })),
  ])

  // Derive the oldest anchor from the ledger's earliest entry, if any.
  const firstEntry = ledger.state.entries.length > 0
    ? ledger.state.entries.reduce((a, b) => (a.ts < b.ts ? a : b))
    : null

  const stats: MilestoneStats = {
    ageDays: 0, // computed by getMilestoneTimeline after settling birthdate
    proposalCount: proposals.length,
    earnedUsdc: ledger.totalTransferredUsdc,
    deploymentCount: ledger.state.entries.filter((e) => e.type === 'run').length,
  }

  const timeline = await getMilestoneTimeline(stats, firstEntry?.ts ?? null)
  return NextResponse.json(timeline)
}
