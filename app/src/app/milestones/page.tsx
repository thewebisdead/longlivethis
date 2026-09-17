// Public survival milestones page at /milestones.
//
// Renders a timeline of the app's survival milestones — how long it has been
// alive, how many proposals reached the board, how much USDC the treasury has
// earned, and how many autonomous deployments it has made — alongside the
// app's age. It is the living record of "how long has this thing kept going".
//
// The data is public (age from the durable birthdate, proposals from the
// GitHub issue list, earned USDC and deployments from the public ledger), so
// nothing here needs a key. The raw JSON is also served at /api/milestones.

import Link from 'next/link'
import { listProposals } from '@/lib/github'
import { readLedger, summarize } from '@/lib/ledger'
import { getMilestoneTimeline } from '@/lib/milestones'
import type { MilestoneTimeline } from '@/lib/milestones'

export const dynamic = 'force-dynamic'

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'age':
      return 'age'
    case 'proposals':
      return 'proposals'
    case 'earned':
      return 'earned'
    case 'deployments':
      return 'deployments'
    default:
      return kind
  }
}

/** Display the stat value under each milestone (e.g. "7 / 7 days"). */
function valueBadge(m: { def: { kind: string; unit: string }; value: number }): string {
  switch (m.def.kind) {
    case 'earned':
      return `$${m.value.toFixed(0)}`
    default:
      return `${m.value} ${m.def.unit}`
  }
}

function fmtAge(days: number): string {
  if (days < 1) return 'less than a day old'
  if (days === 1) return '1 day alive'
  return `${days} days alive`
}

export default async function MilestonesPage() {
  const [proposals, ledger] = await Promise.all([
    listProposals().catch(() => []),
    readLedger().then(summarize).catch(() => ({
      state: { entries: [], lastBalanceUsdc: null },
      totalRunCostUsdc: 0,
      totalTransferredUsdc: 0,
      balanceUsdc: 0,
    })),
  ])

  const firstEntry = ledger.state.entries.length > 0
    ? ledger.state.entries.reduce((a, b) => (a.ts < b.ts ? a : b))
    : null

  let timeline: MilestoneTimeline
  try {
    timeline = await getMilestoneTimeline(
      {
        ageDays: 0,
        proposalCount: proposals.length,
        earnedUsdc: ledger.totalTransferredUsdc,
        deploymentCount: ledger.state.entries.filter((e) => e.type === 'run').length,
      },
      firstEntry?.ts ?? null,
    )
  } catch {
    // Never let a milestone read failure blank the whole page — show the
    // structure with the data we did read.
    timeline = {
      ageDays: 0,
      milestones: [],
      achievedCount: 0,
      totalCount: 0,
      bornAt: 0,
    }
  }

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <p className="text-sm mb-2">
        <Link href="/" className="text-muted underline underline-offset-2 hover:text-fg">
          ← back
        </Link>
      </p>
      <h1 className="text-[clamp(1.8rem,5vw,2.5rem)] font-bold leading-tight mb-1">Survival milestones</h1>
      <p className="mb-6 text-[0.8rem] text-muted">
        How long this app has kept itself alive, and the thresholds it has crossed
        along the way. {timeline.bornAt > 0 && <>Born {fmtDate(timeline.bornAt)} — <span className="text-fg">{fmtAge(timeline.ageDays)}</span>. </>}
        Raw data: <a href="/api/milestones" target="_blank" rel="noopener" className="text-muted underline underline-offset-2 hover:text-fg">/api/milestones</a>.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{timeline.ageDays}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">days alive</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{timeline.achievedCount}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">milestones</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{proposals.length}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">proposals</p>
        </div>
      </div>

      {timeline.milestones.length === 0 ? (
        <p className="text-muted text-sm">No milestones defined yet.</p>
      ) : (
        <ol className="relative border-l border-muted/30 pl-6 ml-3 space-y-6">
          {timeline.milestones.map((m) => (
            <li key={m.def.id} className="relative">
              <span
                className={`absolute -left-[1.85rem] top-1 w-3 h-3 rounded-full border ${
                  m.achieved
                    ? 'bg-emerald-400 border-emerald-300'
                    : 'bg-bg border-muted/50'
                }`}
              />
              <div>
                <p className="font-semibold">
                  {m.def.label}
                  {m.achieved ? (
                    <span className="ml-2 text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                      achieved
                    </span>
                  ) : (
                    <span className="ml-2 text-[0.65rem] text-muted">pending</span>
                  )}
                </p>
                <p className="text-[0.72rem] text-muted mt-0.5">{m.def.description}</p>
                <p className="text-[0.7rem] text-muted mt-1 tabular-nums">
                  <span className="text-fg">{valueBadge(m)}</span>
                  {' · '}
                  <span className="uppercase tracking-wider">{kindLabel(m.def.kind)}</span>
                  {m.achievedAt ? (
                    <>
                      {' · attained '}
                      <span className="text-fg">{fmtDate(m.achievedAt)}</span>
                    </>
                  ) : (
                    <>
                      {' · target '}
                      <span className="text-fg">
                        {m.def.kind === 'earned' ? `$${m.def.target}` : `${m.def.target} ${m.def.unit}`}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
