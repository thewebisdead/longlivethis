import DonateButton from '@/components/DonateButton'
import HnScore from '@/components/HnScore'
import ProposeForm from '@/components/ProposeForm'
import ProposalFeed from '@/components/ProposalFeed'
import VoteNotice from '@/components/VoteNotice'
import { repoUrl, walletAddress, emergencyThresholdDays } from '@/lib/config'
import { listProposals } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'
import { getRunway } from '@/lib/runway'
import { getSurvivalInfo, proposalPriorityLabel } from '@/lib/survival'
import { revalidateSnapshot } from '@/lib/snapshot'
import { runGuardedTrigger } from '@/lib/agentTrigger'
import { listRevenueProposals, revenueSummary } from '@/lib/revenue'
import { donateUri } from '@/lib/donation'

// Config comes from app.env on the VPS at runtime, not from the build —
// render on every request, with the data inline.
export const dynamic = 'force-dynamic'

/**
 * The notice the vote callback redirects back for. Anything else is ignored.
 *
 * `issue`/`dir` come from the same redirect and are display-only — this URL is
 * something anyone can type, so they are parsed defensively and never treated
 * as evidence that a vote happened. A missing or nonsensical issue just drops
 * the reference from the sentence rather than rendering "Vote for # counted."
 */
function voteMessage(params: Record<string, string | string[] | undefined>): string | undefined {
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')
  const status = one('vote')
  if (!status) return undefined

  const issue = Number(one('issue'))
  const ref = Number.isInteger(issue) && issue > 0 ? `#${issue}` : ''
  const dir = one('dir') === 'down' ? 'against' : 'for'

  switch (status) {
    case 'ok':
      return ref ? `Vote ${dir} ${ref} counted.` : 'Vote counted.'
    case 'denied':
      return 'Not authorized — no vote was cast.'
    case 'failed':
      return ref
        ? `Could not record that vote on ${ref}. Please try again.`
        : 'Could not record that vote. Please try again.'
    default:
      return undefined
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const message = voteMessage(await searchParams)

  const [proposals, balance, runway, survival, revenueProps] = await Promise.all([
    // HnScore is rendered inline below — no data dependency to await here.
    listProposals().catch(() => []),
    walletAddress ? getUsdcBalance(walletAddress).catch(() => null) : null,
    getRunway(() =>
      walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0)
    ).catch(() => null),
    getSurvivalInfo(emergencyThresholdDays).catch(() => null),
    listRevenueProposals().catch(() => []),
  ])

  const survivalActive = survival !== null && survival.active

  // Annotate proposals with their emergency-priority label so the feed can
  // surface cost-saving / revenue-generating proposals during emergency.
  const annotatedProposals = proposals.map((p) => ({
    ...p,
    priority: proposalPriorityLabel(p.text),
  }))

  // Background tasks: fire and forget — never block the response on this.
  revalidateSnapshot()
  runGuardedTrigger().catch(() => null)

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <div className="text-center mb-12">
        <p className="text-[clamp(2.5rem,9vw,3.5rem)] leading-[0.95] font-bold tabular-nums tracking-tight">
          {balance === null ? '…' : `$${balance.toFixed(2)}`}
        </p>
        <p className="mt-3 text-xs tracking-[0.18em] uppercase text-muted">treasury · USDC</p>
        {runway != null && runway.runwayDays !== Infinity && (
          <p
            className={`mt-1 text-xs tracking-[0.18em] uppercase ${
              runway.level === 'safe'
                ? 'text-yellow-400'
                : runway.level === 'reduced'
                  ? 'text-orange-400'
                  : 'text-red-400'
            }`}
          >
            dies in {Math.floor(runway.runwayDays)} days
          </p>
        )}
        <DonateButton />
        {survival !== null && (
          <div
            className={`mt-3 inline-block px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md ${
              survivalActive
                ? survival.level === 'paused'
                  ? 'bg-red-900/40 text-red-300 border border-red-500/40'
                  : survival.level === 'critical'
                    ? 'bg-red-900/30 text-red-300 border border-red-500/30'
                    : 'bg-amber-900/30 text-amber-300 border border-amber-500/30'
                : survival.level === 'watch'
                  ? 'bg-blue-900/30 text-blue-300 border border-blue-500/30'
                  : 'bg-emerald-900/30 text-emerald-300 border border-emerald-500/30'
            }`}
          >
            {survival.level === 'normal' && '● normal operation'}
            {survival.level === 'watch' && '◔ watch mode'}
            {survival.level === 'emergency' && '⚠ emergency survival mode'}
            {survival.level === 'critical' && '⛔ critical mode'}
            {survival.level === 'paused' && '■ paused — site only'}
          </div>
        )}
      </div>

      {survival !== null && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            survivalActive
              ? 'border-red-500/40 bg-red-950/20 text-red-100'
              : survival.level === 'watch'
                ? 'border-blue-500/30 bg-blue-950/10 text-blue-100'
                : 'border-emerald-500/30 bg-emerald-950/10 text-emerald-100'
          }`}
        >
          <p className="font-bold">
            {survivalActive ? 'Emergency Survival Mode is active' : 'Treasury status'}
          </p>
          <p className="mt-1 text-xs">{survival.policy}</p>
          {survivalActive && (
            <p className="mt-2 text-[0.7rem] opacity-80">
              Runs skipped: {survival.runsSkipped} · Runs downshifted:{' '}
              {survival.runsDownshifted} · Cost-saving proposals:{' '}
              {survival.costSavingProposals} · Revenue proposals:{' '}
              {survival.revenueProposals}
            </p>
          )}
        </div>
      )}

      {revenueProps.length > 0 && (() => {
        const rsum = revenueSummary(revenueProps)
        return (
          <div className="mb-8 border border-blue-500/30 rounded-lg px-4 py-4 bg-blue-950/10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[0.8rem] font-bold tracking-widest uppercase">
                ☰ Funding opportunities
              </h2>
              <span className="text-[0.72rem] text-muted">
                {rsum.openCount} open ·{' '}
                {rsum.fundedCount} funded ·
                {' '}${rsum.openTargetUsdc.toFixed(0)} needed
              </span>
            </div>
            <div className="space-y-2">
              {revenueProps.slice(0, 8).map((rp) => {
                const fundLink = walletAddress
                  ? donateUri(walletAddress, rp.minUsdc)
                  : null
                return (
                  <div
                    key={rp.id}
                    className={`text-sm border rounded px-3 py-2 flex items-start gap-3 ${
                      rp.status === 'funded'
                        ? 'border-emerald-500/30 bg-emerald-950/15 opacity-70'
                        : rp.status === 'claimed'
                          ? 'border-amber-500/30 bg-amber-950/15'
                          : 'border-muted/30'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[0.85rem]">
                        {rp.title}
                        <span className="text-muted ml-2 text-[0.72rem]">
                          ${rp.targetUsdc.toFixed(0)}
                        </span>
                        {rp.status !== 'open' && (
                          <span
                            className={`ml-2 text-[0.65rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                              rp.status === 'funded'
                                ? 'bg-emerald-900/40 text-emerald-300'
                                : 'bg-amber-900/40 text-amber-300'
                            }`}
                          >
                            {rp.status}
                          </span>
                        )}
                      </div>
                      <p className="text-[0.72rem] text-muted mt-0.5 line-clamp-2">
                        {rp.description}
                      </p>
                    </div>
                    {rp.status === 'open' && fundLink && (
                      <a
                        href={fundLink}
                        target="_blank"
                        rel="noopener"
                        className="shrink-0 bg-fg text-bg border border-fg px-3 py-1.5 text-[0.75rem] font-semibold no-underline hover:bg-bg hover:text-fg transition-colors"
                      >
                        Fund from ${rp.minUsdc}
                      </a>
                    )}
                  </div>
                )
              })}
              {revenueProps.length > 8 && (
                <p className="text-[0.72rem] text-muted mt-1">
                  +{revenueProps.length - 8} more
                </p>
              )}
            </div>
          </div>
        )
      })()}

      <p className="text-[1.35rem] font-bold leading-tight mb-2">
        The web is dead, <a className='hover:underline' href='#'>longlivethis.site</a>!
      </p>
      <p className="mb-5 text-[0.8rem] flex gap-4 flex-wrap">
        {repoUrl && (
          <>
            <a
              href={`${repoUrl}#readme`}
              target="_blank"
              rel="noopener"
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              About
            </a>
            <a
              href={`${repoUrl}/blob/main/constitution.md`}
              target="_blank"
              rel="noopener"
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              Constitution
            </a>
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener"
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              GitHub
            </a>
            <a
              href="/ledger"
              className="text-muted underline underline-offset-2 hover:text-fg"
            >
              Ledger
            </a>
          </>
        )}
        <HnScore />
      </p>

      {message && <VoteNotice message={message} />}

      <ProposeForm emergencyActive={survivalActive} />
      <ProposalFeed proposals={annotatedProposals} emergencyActive={survivalActive} />
    </main>
  )
}
