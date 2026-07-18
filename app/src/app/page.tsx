import Header from '@/components/Header'
import ProposeForm from '@/components/ProposeForm'
import ProposalFeed from '@/components/ProposalFeed'
import Chat from '@/components/Chat'
import { listProposals } from '@/lib/github'
import { getUsdcBalance } from '@/lib/treasury'

// Env vars (REPO_URL, WALLET_ADDRESS, …) are set at runtime (app.env on the
// VPS), not at build time — render on every request, with the data inline.
export const dynamic = 'force-dynamic'

export default async function Home() {
  const repoUrl = (process.env.REPO_URL ?? '').replace(/\/$/, '') || null
  const wallet = process.env.WALLET_ADDRESS ?? ''
  const [proposals, balance] = await Promise.all([
    listProposals().catch(() => []),
    wallet ? getUsdcBalance(wallet).catch(() => null) : null,
  ])

  return (
    <>
      <Header projectName="longlivethis" balance={balance} repoUrl={repoUrl} />
      <main className="flex-1 w-full max-w-[720px] mx-auto px-6 py-8">
        <p className="text-[1.35rem] font-bold leading-tight mb-2">
          The web is dead, long live the web
        </p>
        <p className="mb-5 text-[0.8rem] flex gap-4 flex-wrap">
          {repoUrl && (
            <>
              <a
                href={`${repoUrl}/blob/main/constitution.md`}
                target="_blank"
                rel="noopener"
                className="text-muted underline underline-offset-2 hover:text-fg"
              >
                Constitution
              </a>
              <a
                href={`${repoUrl}#readme`}
                target="_blank"
                rel="noopener"
                className="text-muted underline underline-offset-2 hover:text-fg"
              >
                About
              </a>
            </>
          )}
        </p>

        <ProposeForm />
        <ProposalFeed proposals={proposals} sponsorCost={balance !== null ? Math.max(balance * 0.1, 0) : null} />
        <Chat />
      </main>
    </>
  )
}
