import type { Proposal } from '@/lib/types'

// Most votes first, then newest. created_at is not rendered — the feed shows
// only the title — but it still breaks ties here.
function sortProposals(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort(
    (a, b) => b.votes - a.votes || +new Date(b.created_at) - +new Date(a.created_at)
  )
}

// Voting is a link, not a fetch: /api/vote redirects to GitHub's consent screen
// and the callback redirects back here, so the whole flow is plain navigation.
// That is why this stays a server component with no client JavaScript — and why
// it still works when the OAuth credentials are absent, since /api/vote then
// redirects to the issue on GitHub to be reacted to by hand.
function VoteButton({ issue, dir }: { issue: number; dir: 'up' | 'down' }) {
  const up = dir === 'up'
  return (
    <a
      href={`/api/vote?issue=${issue}&dir=${dir}`}
      title={up ? 'Vote for this (via GitHub)' : 'Vote against this (via GitHub)'}
      aria-label={up ? 'Vote for' : 'Vote against'}
      className="block px-2 leading-none text-muted hover:text-fg focus:text-fg focus:outline-none"
    >
      {up ? '▲' : '▼'}
    </a>
  )
}

export default function ProposalFeed({ proposals }: { proposals: Proposal[] }) {
  const rows = sortProposals(proposals)

  return (
    <div>
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mt-8 mb-4">Proposals</h2>
      {rows.length > 0 && (
        <p className="text-[0.72rem] text-muted mb-4">
          Vote with ▲ / ▼ — you sign in with GitHub once, then land straight back here. Click a
          proposal to read the discussion.
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
            className="border-t border-fg last:border-b py-4 flex gap-4 items-start"
          >
            <span className="flex flex-col items-center gap-1 shrink-0">
              <VoteButton issue={p.id} dir="up" />
              <span className="inline-block border border-fg font-mono text-[0.75rem] px-[0.6rem] py-[0.4rem] min-w-[3rem] text-center tabular-nums">
                {p.votes}
              </span>
              <VoteButton issue={p.id} dir="down" />
            </span>
            <a
              href={p.url}
              target="_blank"
              rel="noopener"
              className="flex-1 no-underline text-fg group"
            >
              <span className="block text-[0.9rem] leading-normal group-hover:underline">
                {p.title}
              </span>
            </a>
          </div>
        ))
      )}
    </div>
  )
}
