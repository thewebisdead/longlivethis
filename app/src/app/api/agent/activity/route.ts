import { NextResponse } from 'next/server'
import { readLedger, summarize } from '@/lib/ledger'
import { readAgentActivity } from '@/lib/agentActivity'
import { listAgentPullRequests, listAgentWorkflowRuns } from '@/lib/github'
import { emergencyThresholdDays } from '@/lib/config'
import { getSurvivalInfo as getSurvival } from '@/lib/survival'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/activity — the public agent activity log.
 *
 * Assembles everything that makes up the agent's public activity record:
 *   - the durable activity log (evaluations + decisions + implementation
 *     attempts, recorded on every guarded trigger),
 *   - run costs + transfers from the public ledger,
 *   - live GitHub PRs and CI/deploy workflow runs,
 *   - the current Emergency Survival Mode status.
 *
 * All read-only, no side effects, nothing keyed. Best-effort: GitHub failures
 * surface as empty lists rather than errors, so the endpoint always answers.
 */
export async function GET() {
  const [activity, ledger, prs, runs, survival] = await Promise.all([
    readAgentActivity().catch(() => ({ entries: [] })),
    readLedger().then(summarize).catch(() => null),
    listAgentPullRequests().catch(() => []),
    listAgentWorkflowRuns().catch(() => []),
    getSurvival(emergencyThresholdDays).catch(() => null),
  ])

  return NextResponse.json({
    activity: activity.entries,
    activityTotal: activity.entries.length,
    ledger,
    pullRequests: prs,
    workflowRuns: runs,
    survivalMode: survival,
  })
}
