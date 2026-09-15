import DonateButton from '@/components/DonateButton'
import HnScore from '@/components/HnScore'
import ProposeForm from '@/components/ProposeForm'
import ProposalFeed from '@/components/ProposalFeed'
import VoteNotice from '@/components/VoteNotice'
import { repoUrl, walletAddress } from '@/lib/config'
import { listProposals } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'

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

  const [proposals, balance] = await Promise.all([
    // HnScore is rendered inline below — no data dependency to await here.
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
        <DonateButton />
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
        <HnScore />
      </p>

      {message && <VoteNotice message={message} />}

      <ProposeForm />
      <ProposalFeed proposals={proposals} />
    </main>
  )
}
