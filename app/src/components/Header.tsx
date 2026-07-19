import ThemeToggle from '@/components/ThemeToggle'

export default function Header({
  projectName,
  balance,
  repoUrl,
}: {
  projectName: string
  balance: number | null
  repoUrl: string | null
}) {
  return (
    <header className="border-b border-fg px-8 py-6 flex justify-between items-baseline gap-4 flex-wrap">
      <div className="flex items-center gap-3">
        {/* logo is black-on-transparent; logo-auto inverts for dark, keeps original for light */}
        <img src="/logo.png" alt="" aria-hidden className="h-7 w-7 logo-auto" />
        <h1 className="text-[1.1rem] tracking-[0.08em] font-semibold">{projectName}</h1>
      </div>
      <div className="text-xs text-muted flex gap-3 items-center flex-wrap">
        <span>
          treasury: <span className="text-fg">{balance === null ? '…' : balance.toFixed(2)}</span> USDC
        </span>
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener"
            className="text-muted hover:text-fg hover:underline underline-offset-2"
          >
            GitHub
          </a>
        )}
        <ThemeToggle />
      </div>
    </header>
  )
}
