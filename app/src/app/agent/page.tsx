// Public Agent Activity page at /agent.
//
// Shows what the agent has been doing: which proposals it evaluated, the
// decisions it made (run / downshift / skip), its implementation attempts, the
// costs of those runs, the pull requests it opened, the CI / test results, and
// the deployments / workflow runs behind them.
//
// All of the data is public:
//   - the durable activity log (constituent: decisions, runway, survival mode)
//     recorded by the agent trigger on every guarded evaluation,
//   - the public ledger (run costs + transfers) that already powers /ledger,
//   - live GitHub PRs and CI/deploy workflow runs,
//   - the current Emergency Survival Mode status.
//
// Nothing here needs a key. Raw JSON is also served at /api/agent/activity.

import Link from 'next/link'
import { readLedger, summarize } from '@/lib/ledger'
import { readAgentActivity } from '@/lib/agentActivity'
import { listAgentPullRequests, listAgentWorkflowRuns } from '@/lib/github'
import { emergencyThresholdDays } from '@/lib/config'
import { getSurvivalInfo } from '@/lib/survival'
import type { AgentActivityEntry } from '@/lib/agentActivity'

export const dynamic = 'force-dynamic'

function fmtDate(ts: string | number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function modeLabel(mode: string): { text: string; cls: string } {
  switch (mode) {
    case 'run':
      return { text: 'run', cls: 'bg-emerald-900/40 text-emerald-300' }
    case 'downshift':
      return { text: 'downshift', cls: 'bg-amber-900/40 text-amber-300' }
    default:
      return { text: 'skip', cls: 'bg-red-900/40 text-red-300' }
  }
}

function statusBadge(conclusion: string | null, status: string): { text: string; cls: string } {
  if (status !== 'completed') {
    return { text: status, cls: 'bg-blue-900/40 text-blue-300' }
  }
  switch (conclusion) {
    case 'success':
      return { text: 'passed', cls: 'bg-emerald-900/40 text-emerald-300' }
    case 'neutral':
      return { text: 'neutral', cls: 'bg-muted/30 text-muted' }
    default:
      return { text: conclusion ?? 'failed', cls: 'bg-red-900/40 text-red-300' }
  }
}

export default async function AgentPage() {
  const [activity, ledger, prs, runs, survival] = await Promise.all([
    readAgentActivity().catch(() => ({ entries: [] as AgentActivityEntry[] })),
    readLedger().then(summarize).catch(() => null),
    listAgentPullRequests().catch(() => []),
    listAgentWorkflowRuns().catch(() => []),
    getSurvivalInfo(emergencyThresholdDays).catch(() => null),
  ])

  const entries = activity.entries
  const dispatched = entries.filter((e) => e.dispatched).length
  const skipped = entries.filter((e) => e.mode === 'skip').length
  const runCost = ledger?.totalRunCostUsdc ?? 0

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <p className="text-sm mb-2">
        <Link href="/" className="text-muted underline underline-offset-2 hover:text-fg">
          ← back
        </Link>
      </p>
      <h1 className="text-[clamp(1.8rem,5vw,2.5rem)] font-bold leading-tight mb-1">Agent activity</h1>
      <p className="mb-6 text-[0.8rem] text-muted">
        What the agent has evaluated, decided, attempted and shipped. Raw data:{' '}
        <a href="/api/agent/activity" target="_blank" rel="noopener" className="text-muted underline underline-offset-2 hover:text-fg">
          /api/agent/activity
        </a>
        {survival && (
          <>
            {' · '}
            <span className="uppercase tracking-wider">{survival.label} mode</span>
          </>
        )}
        .
      </p>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{entries.length}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">evaluations</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{dispatched}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">runs dispatched</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">${runCost.toFixed(2)}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">run cost</p>
        </div>
      </div>

      {/* Evaluations & decisions */}
      <h2 className="text-[0.8rem] font-bold tracking-widest uppercase mb-3">Evaluations &amp; decisions</h2>
      {entries.length === 0 ? (
        <p className="text-muted text-sm mb-8">
          No evaluations recorded yet — they appear as the agent evaluates the treasury and the board.
        </p>
      ) : (
        <div className="mb-8 space-y-3">
          {entries.map((e, i) => {
            const m = modeLabel(e.mode)
            return (
              <div key={i} className="border border-muted/30 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${m.cls}`}>
                      {m.text}
                    </span>
                    {e.dispatched && (
                      <span className="text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                        dispatched
                      </span>
                    )}
                    {e.throttled && (
                      <span className="text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/30 text-muted">
                        throttled
                      </span>
                    )}
                    <span className="text-[0.65rem] text-muted tabular-nums">{fmtDate(e.ts)}</span>
                  </div>
                  {e.runId && (
                    <span className="text-[0.65rem] text-muted mono">{e.runId}</span>
                  )}
                </div>
                <p className="mt-2 text-[0.8rem]">{e.reason}</p>
                <p className="mt-1 text-[0.7rem] text-muted">
                  runway {e.level} · {e.runwayDays === Infinity ? '∞' : `${e.runwayDays} days`} · survival {e.survivalLevel}
                  {e.error && <span className="text-red-400"> · {e.error}</span>}
                </p>
                {e.proposals.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[0.7rem] text-muted cursor-pointer hover:text-fg">
                      {e.proposals.length} proposal{e.proposals.length === 1 ? '' : 's'} considered
                    </summary>
                    <ul className="mt-2 space-y-1 text-[0.72rem] text-muted list-disc pl-5">
                      {e.proposals.map((p, j) => (
                        <li key={j}>{p}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Costs */}
      <h2 className="text-[0.8rem] font-bold tracking-widest uppercase mb-3">Costs</h2>
      <div className="mb-8 border border-muted/30 rounded-lg p-4 text-sm">
        {ledger ? (
          <p className="text-muted">
            Total run cost <span className="text-fg">${ledger.totalRunCostUsdc.toFixed(2)}</span> ·{' '}
            total incoming <span className="text-fg text-green-400">+${ledger.totalTransferredUsdc.toFixed(2)}</span> ·{' '}
            treasury <span className="text-fg">${ledger.balanceUsdc.toFixed(2)}</span>. Full breakdown on the{' '}
            <Link href="/ledger" className="text-muted underline underline-offset-2 hover:text-fg">ledger</Link>.
          </p>
        ) : (
          <p className="text-muted">No cost data yet.</p>
        )}
      </div>

      {/* Pull requests */}
      <h2 className="text-[0.8rem] font-bold tracking-widest uppercase mb-3">Pull requests</h2>
      <div className="mb-8 border border-muted/30 rounded-lg p-4">
        {prs.length === 0 ? (
          <p className="text-muted text-sm">No pull requests found.</p>
        ) : (
          <ul className="space-y-2">
            {prs.slice(0, 15).map((pr) => (
              <li key={pr.number} className="flex items-start justify-between gap-3 text-sm">
                <a
                  href={pr.html_url}
                  target="_blank"
                  rel="noopener"
                  className="text-fg underline underline-offset-2 hover:text-muted"
                >
                  #{pr.number} {pr.title}
                </a>
                <span className="text-[0.72rem] text-muted whitespace-nowrap">
                  {pr.merged ? 'merged' : pr.state} · {fmtDate(pr.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* CI / deployments */}
      <h2 className="text-[0.8rem] font-bold tracking-widest uppercase mb-3">CI &amp; deployments</h2>
      <div className="mb-8 border border-muted/30 rounded-lg p-4">
        {runs.length === 0 ? (
          <p className="text-muted text-sm">No workflow runs found.</p>
        ) : (
          <ul className="space-y-2">
            {runs.slice(0, 20).map((run) => {
              const s = statusBadge(run.conclusion, run.status)
              return (
                <li key={run.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-fg truncate">{run.name}</span>
                    {run.headBranch && (
                      <span className="text-muted text-[0.72rem] ml-2 mono">{run.headBranch}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <span className={`text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${s.cls}`}>
                      {s.text}
                    </span>
                    <span className="text-[0.72rem] text-muted">{fmtDate(run.createdAt)}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}
