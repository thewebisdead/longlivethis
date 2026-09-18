import { repoUrl } from '@/lib/config'
import type { Proposal, ProposalEconomics } from '@/lib/types'
import { hasEconomics } from '@/lib/github'
import type { ActualEconomics } from '@/lib/economics'

// A proposal with an emergency-priority classification attached (used by the
// feed to surface cost-saving / revenue proposals during emergency mode).
export interface RankedProposal extends Proposal {
  priority: 'cost-saving' | 'revenue' | 'standard'
}

// Render an estimate-vs-actual comparison for a single economics figure.
function CompareRow({ label, estimate, actual }: { label: string; estimate: number; actual: number | null }) {
  if (actual === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted">
        <span>{label}</span>
        <span className="font-mono tabular-nums">${estimate.toFixed(0)} est</span>
      </span>
    )
  }
  const diff = actual - estimate
  const good = diff <= 0 // actual at or under the estimate is better (cost bound)
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.65rem]">
      <span className="text-muted">{label}</span>
      <span
        className={`font-mono tabular-nums ${
          good ? 'text-emerald-300' : 'text-red-300'
        }`}
      >
        ${actual.toFixed(0)} actual
      </span>
      <span className={`font-mono tabular-nums ${good ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
        (${estimate.toFixed(0)} est)
      </span>
    </span>
  )
}

// A prominent cost estimate shown for every proposal that carries one, so a
// voter sees what a proposal spends out of the treasury BEFORE they vote on it.
// Rendered as a compact two-line block (one-time cost, then recurring cost)
// that sits right beside the vote control rather than as a footnote under the
// title — the whole point is that the cost is visible up front, while deciding.
function CostEstimate({ economics }: { economics: ProposalEconomics }) {
  const { estimatedCostUsdc, recurringCostUsdc } = economics
  const haveCost = estimatedCostUsdc !== null
  const haveRecurring = recurringCostUsdc !== null

  return (
    <span
      className="flex flex-col items-center gap-0.5 shrink-0"
      title="Estimated treasury cost. One-time implementation cost, then recurring cost per funding cycle."
    >
      <span className="text-[0.55rem] uppercase tracking-wider text-muted">cost</span>
      <span className="font-mono tabular-nums text-[0.8rem] leading-none whitespace-nowrap">
        ${(estimatedCostUsdc ?? 0).toFixed(0)}
      </span>
      {haveRecurring ? (
        <span className="font-mono tabular-nums text-[0.6rem] leading-none text-muted whitespace-nowrap">
          +${(recurringCostUsdc ?? 0).toFixed(0)}/cycle
        </span>
      ) : haveCost ? (
        <span className="font-mono tabular-nums text-[0.6rem] leading-none text-muted">
          one-time
        </span>
      ) : null}
    </span>
  )
}

// How many proposals the page renders. The board can legitimately hold more
// (up to the 500 hard cap in lib/github.ts) after a burst the cleanup workflow
// has not swept yet, and nobody scrolls 500 rows. Display only — the duplicate
// check and the agent's selection both still see every open proposal.
const DISPLAY_MAX = 100

// Most votes first, then oldest when votes are tied. created_at is not rendered
// — the feed shows only the title — but it still breaks ties here. The oldest
// proposal is preferred so that earlier-submitted ideas get built first when
// support is equal.
function sortProposals<T extends Proposal>(proposals: T[]): T[] {
  return [...proposals].sort(
    (a, b) => b.votes - a.votes || +new Date(a.created_at) - +new Date(b.created_at)
  )
}
// Voting is a form submission, not a fetch: /api/vote redirects to GitHub's
// consent screen and the callback redirects back here, so the whole flow is
// plain navigation. That is why this stays a server component with no client
// JavaScript — and why it still works when the OAuth credentials are absent,
// since /api/vote then redirects to the issue on GitHub to be reacted to by
// hand.
//
// A form rather than the <a> this used to be, because a link is something ANY
// page can make a visitor follow, and following it is enough to cast their vote
// (see the route). `contents` keeps the form out of the layout, so the button
// still sits directly in the parent's flex column.
function VoteButton({ issue, dir }: { issue: number; dir: 'up' | 'down' }) {
  const up = dir === 'up'
  return (
    <form action="/api/vote" method="post" className="contents">
      <input type="hidden" name="issue" value={issue} />
      <input type="hidden" name="dir" value={dir} />
      <button
        type="submit"
        title={up ? 'Vote for this (via GitHub)' : 'Vote against this (via GitHub)'}
        aria-label={up ? 'Vote for' : 'Vote against'}
        className="block px-1 text-xl leading-none text-muted cursor-pointer hover:text-fg focus:text-fg focus:outline-none"
      >
        {up ? '▲' : '▼'}
      </button>
    </form>
  )
}

export default function ProposalFeed({
  proposals,
  emergencyActive = false,
  actualEconomics = [],
}: {
  proposals: RankedProposal[]
  emergencyActive?: boolean
  /** Recorded actual outcomes for implemented proposals, keyed by issue no. */
  actualEconomics?: ActualEconomics[]
}) {
  const ranked = sortProposals(proposals)
  const actualByProposal = new Map(actualEconomics.map((a) => [a.proposalId, a]))

  // In emergency mode, cost-saving and revenue proposals are surfaced first.
  // The sort still respects votes so the community voice is not drowned;
  // priority only breaks near-ties.
  if (emergencyActive) {
    ranked.sort(
      (a, b) =>
        Number(b.priority !== 'standard') - Number(a.priority !== 'standard') ||
        b.votes - a.votes ||
        +new Date(a.created_at) - +new Date(b.created_at)
    )
  }

  const rows = ranked.slice(0, DISPLAY_MAX)
  const hidden = ranked.length - rows.length

  return (
    <div>
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mt-8 mb-4">Proposals</h2>
      {rows.length > 0 && (
        <p className="text-[0.72rem] text-muted mb-4">
          Vote with ▲ / ▼ (automatic sign in with GitHub) or vote on github with 👍/👎. Each row shows the estimated treasury cost next to the vote — a one-time implementation cost and a per-cycle recurring cost where the proposer provided one. [There might be a small delay in the vote showing here due to caching]
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted text-[0.85rem] text-center my-12">
          Nothing to implement yet :( Propose something!
        </p>
      ) : (
        rows.map((p) => {
          const econ = p.economics
          const hasEcon = hasEconomics(econ)
          const actual = actualByProposal.get(p.id) ?? null
          const showActual = econ.estimatedCostUsdc !== null && actual?.actualCostUsdc != null
          // The anchor id is where the vote callback redirects back to, so a
          // voter returns to the proposal they just voted on.
          return (
          <div
            key={p.id}
            id={`p${p.id}`}
            className="border-t border-fg last:border-b py-4 flex gap-4 items-center"
          >
            <span className="flex flex-col items-center gap-1 shrink-0">
              <VoteButton issue={p.id} dir="up" />
              <span className="inline-block border border-fg font-mono text-[0.75rem] px-2 py-[0.4rem] min-w-12 text-center tabular-nums">
                {p.votes}
              </span>
              <VoteButton issue={p.id} dir="down" />
            </span>
            {/* Estimated treasury cost, shown up front so voters know what they
                are spending before they vote. Omitted when the proposal carries
                no cost estimate. */}
            {econ.estimatedCostUsdc !== null && (
              <CostEstimate economics={econ} />
            )}
            <a
              href={p.url}
              target="_blank"
              rel="noopener"
              className="flex-1 no-underline text-fg text-left group"
            >
              <span className="block text-[1rem] leading-normal group-hover:underline">
                {p.title} <span className="text-muted">#{p.id}</span>
              </span>
              <span className="flex gap-2 flex-wrap mt-1">
                {p.category === 'revenue' && (
                  <span className="inline-block text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-500/40">
                    ▲ revenue
                  </span>
                )}
                {p.category === 'feature' && (
                  <span className="inline-block text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-500/40">
                    ✦ feature
                  </span>
                )}
                {p.category === 'cost-saving' && (
                  <span className="inline-block text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-500/40">
                    ▼ cost-saving
                  </span>
                )}
                {emergencyActive && p.priority !== 'standard' && (
                  <span
                    className={`inline-block text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      p.priority === 'cost-saving'
                        ? 'bg-amber-900/40 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-900/40 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    {(p.priority === 'cost-saving' ? '▼ cost-saving' : '▲ revenue') + ' priority'}
                  </span>
                )}
              </span>
              {hasEcon && (
                <span className="flex gap-3 flex-wrap mt-1 text-[0.68rem]">
                  {/* The estimated one-time + recurring cost is already shown
                      prominently by the CostEstimate badge beside the vote
                      control. This line only appears once an actual outcome is
                      recorded, comparing it against the estimate. */}
                  {econ.estimatedCostUsdc !== null && showActual && (
                    <CompareRow
                      label="cost"
                      estimate={econ.estimatedCostUsdc}
                      actual={actual?.actualCostUsdc ?? null}
                    />
                  )}
                  {econ.recurringCostUsdc !== null && actual?.actualRecurringCostUsdc != null && (
                    <CompareRow
                      label="recurring"
                      estimate={econ.recurringCostUsdc}
                      actual={actual.actualRecurringCostUsdc}
                    />
                  )}
                  {econ.expectedBenefitUsdc !== null &&
                    (actual?.actualBenefitUsdc != null ? (
                      <span className="inline-flex items-center gap-1.5 text-[0.65rem]">
                        <span className="text-muted">{econ.benefitKind === 'savings' ? 'saves' : 'earns'}</span>
                        <span
                          className={`font-mono tabular-nums ${
                            actual.actualBenefitUsdc >= econ.expectedBenefitUsdc
                              ? 'text-emerald-300'
                              : 'text-red-300'
                          }`}
                        >
                          ${actual.actualBenefitUsdc.toFixed(0)} actual
                        </span>
                        <span className="font-mono tabular-nums text-muted">
                          (${econ.expectedBenefitUsdc.toFixed(0)} est)
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted">
                        <span>{econ.benefitKind === 'savings' ? 'saves' : 'earns'}</span>
                        <span className="font-mono tabular-nums">${econ.expectedBenefitUsdc.toFixed(0)}est</span>
                      </span>
                    ))}
                  {econ.runwayImpactDays !== null && econ.runwayImpactDays !== 0 && (
                    <span className="inline-flex items-center gap-1 text-muted">
                      <span>runway</span>
                      <span className="font-mono tabular-nums">
                        {econ.runwayImpactDays > 0 ? '+' : ''}{econ.runwayImpactDays}d
                      </span>
                    </span>
                  )}
                </span>
              )}
            </a>
            {/* Share card for this proposal — every link post is distribution.
                A tiny glyph opens /api/og?proposal=N, the dynamic card with
                the balance, runway and this proposal's votes/title. */}
            <a
              href={`/api/og?proposal=${p.id}`}
              target="_blank"
              rel="noopener"
              title={`Share image for #${p.id} (treasury + runway)`}
              className="shrink-0 text-muted hover:text-fg no-underline text-[0.85rem]"
            >
              🔗
            </a>
          </div>
        )
        }))}
      {hidden > 0 && (
        <p className="text-[0.72rem] text-muted mt-4">
          {hidden} lower-ranked {hidden === 1 ? 'proposal is' : 'proposals are'} not shown.{' '}
          {repoUrl ? (
            <a
              href={`${repoUrl}/issues`}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-2 hover:text-fg"
            >
              See all on GitHub
            </a>
          ) : null}
        </p>
      )}
    </div>
  )
}
