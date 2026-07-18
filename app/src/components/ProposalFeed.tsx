import type { Proposal } from '@/lib/types'

function fmt(d: string): string {
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${dt.getFullYear()}`
}

// Most votes first, then newest.
function sortProposals(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort(
    (a, b) => b.votes - a.votes || +new Date(b.created_at) - +new Date(a.created_at)
  )
}

export default function ProposalFeed({ proposals }: { proposals: Proposal[] }) {
  const rows = sortProposals(proposals)

  return (
    <div>
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mt-8 mb-4">Proposals</h2>
      <p className="text-[0.72rem] text-muted mb-4">
        Click to open a proposal on GitHub, react with 👍 to vote for it or 👎 to vote
        against.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted text-[0.85rem]">Nothing to implement yet :( Propose something!</p>
      ) : (
        rows.map((p) => (
          <a
            key={p.id}
            href={p.url}
            target="_blank"
            rel="noopener"
            title="React on GitHub to vote"
            className="no-underline text-fg border-t border-fg last:border-b py-4 flex gap-4 items-start hover:bg-fg hover:text-bg group"
          >
            <span className="inline-block border border-fg font-mono text-[0.75rem] px-[0.6rem] py-[0.4rem] min-w-[3rem] text-center shrink-0 group-hover:border-bg">
              ▲ {p.votes}
            </span>
            <span className="flex-1">
              <span className="block text-[0.9rem] leading-normal mb-1">{p.text}</span>
              <span className="block text-[0.72rem] text-muted group-hover:text-bg">
                {fmt(p.created_at)}
              </span>
            </span>
          </a>
        ))
      )}
    </div>
  )
}
