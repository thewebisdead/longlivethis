import { repoUrl } from '@/lib/config'
import type { Proposal } from '@/lib/types'

// How many proposals the page renders. The board can legitimately hold more
// (up to the 500 hard cap in lib/github.ts) after a burst the cleanup workflow
// has not swept yet, and nobody scrolls 500 rows. Display only — the duplicate
// check and the agent's selection both still see every open proposal.
const DISPLAY_MAX = 100

// Most votes first, then newest. created_at is not rendered — the feed shows
// only the title — but it still breaks ties here.
//
// This is the same order scripts/locked/cleanup-proposals.sh evicts from the
// bottom of, so what drops off the end of this list is also what gets closed
// first when the board is full. Keep the two in lockstep.
function sortProposals(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort(
    (a, b) => b.votes - a.votes || +new Date(b.created_at) - +new Date(a.created_at)
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

export default function ProposalFeed({ proposals }: { proposals: Proposal[] }) {
  const ranked = sortProposals(proposals)
  const rows = ranked.slice(0, DISPLAY_MAX)
  const hidden = ranked.length - rows.length

  return (
    <div>
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mt-8 mb-4">Proposals</h2>
      {rows.length > 0 && (
        <p className="text-[0.72rem] text-muted mb-4">
          Vote with ▲ / ▼ (automatic sign in with GitHub) or vote on github with 👍/👎. [There might be a small delay in the vote showing here due to caching]
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted text-[0.85rem] text-center my-12">
          Nothing to implement yet :( Propose something!
        </p>
      ) : (
        rows.map((p) => (
          // The anchor id is where the vote callback redirects back to, so a
          // voter returns to the proposal they just voted on.
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
            <a
              href={p.url}
              target="_blank"
              rel="noopener"
              className="flex-1 no-underline text-fg text-left group"
            >
              <span className="block text-[1rem] leading-normal group-hover:underline">
                {p.title} <span className="text-muted">#{p.id}</span>
              </span>
            </a>
          </div>
        ))
      )}
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
