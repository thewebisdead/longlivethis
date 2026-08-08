import ProposeForm from '@/components/ProposeForm'
import ProposalFeed from '@/components/ProposalFeed'
import { repoUrl, walletAddress } from '@/lib/config'
import { listProposals } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'

// Config comes from app.env on the VPS at runtime, not from the build —
// render on every request, with the data inline.
export const dynamic = 'force-dynamic'

// What the vote callback redirects back with. Anything else is ignored.
const VOTE_MESSAGE: Record<string, string> = {
  ok: 'Vote counted.',
  denied: 'Not authorized — no vote was cast.',
  failed: 'Could not record that vote. Please try again.',
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const voteParam = (await searchParams).vote
  const voteMessage = typeof voteParam === 'string' ? VOTE_MESSAGE[voteParam] : undefined

  const [proposals, balance] = await Promise.all([
    listProposals().catch(() => []),
    walletAddress ? getUsdcBalance(walletAddress).catch(() => null) : null,
  ])

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <div className="text-center mb-12">
        <p className="text-[clamp(2.5rem,9vw,3.5rem)] leading-[0.95] font-bold tabular-nums tracking-tight">
          {balance === null ? '…' : `$${balance.toFixed(2)}`}
        </p>
        <p className="mt-3 text-xs tracking-[0.18em] uppercase text-muted">treasury · USDC</p>
      </div>

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
          </>
        )}
      </p>

      {voteMessage && (
        <p
          role="status"
          className="mb-5 border border-fg px-3 py-2 text-[0.78rem]"
        >
          {voteMessage}
        </p>
      )}

      <ProposeForm />
      <ProposalFeed proposals={proposals} />
    </main>
  )
}
