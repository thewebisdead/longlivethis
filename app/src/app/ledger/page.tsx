// Public ledger page at /ledger.
//
// Renders the append-only transparency record: every agent run cost and every
// incoming USDC transfer to the treasury. Transparency buys donations — a
// visitor can see exactly where treasury money goes and what comes in, which is
// the strongest case for funding the next run. The data comes from the on-chain
// treasury (the balance read) and the run-cost stream; nothing here needs a
// private key. The raw JSON is also served at /api/ledger for anyone who wants
// the machine-readable record.
//
// The page renders the ledger live on every request (it is small — a few dozen
// to a few hundred rows), so it always reflects the latest recorded activity.

import Link from 'next/link'
import { walletAddress } from '@/lib/config'
import { explorerUrl } from '@/lib/donation'
import { readLedger, summarize } from '@/lib/ledger'
import type { LedgerEntry } from '@/lib/ledger'

export const dynamic = 'force-dynamic'

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function kindLabel(entry: LedgerEntry): string {
  return entry.type === 'run' ? 'run cost' : 'transfer'
}

/** Amount shown with a sign: runs are outgoing (−), transfers incoming (+). */
function signedAmount(entry: LedgerEntry): string {
  if (entry.type === 'run') return `−${usd(entry.totalCostUsdc)}`
  return `+${usd(entry.amountUsdc)}`
}

export default async function LedgerPage() {
  const view = await readLedger().then(summarize).catch(() => ({ state: { entries: [], lastBalanceUsdc: null }, totalRunCostUsdc: 0, totalTransferredUsdc: 0, balanceUsdc: 0 }))
  const entries = view.state.entries
  const displayBalance = walletAddress ? view.balanceUsdc : 0

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <p className="text-sm mb-2">
        <Link href="/" className="text-muted underline underline-offset-2 hover:text-fg">
          ← back
        </Link>
      </p>
      <h1 className="text-[clamp(1.8rem,5vw,2.5rem)] font-bold leading-tight mb-1">Public ledger</h1>
      <p className="mb-6 text-[0.8rem] text-muted">
        Every run cost and every incoming transfer, append-only.{' '}
        {walletAddress && (
          <a
            href={explorerUrl(walletAddress)}
            target="_blank"
            rel="noopener"
            className="text-muted underline underline-offset-2 hover:text-fg"
          >
            On-chain record
          </a>
        )}
        {`. Raw data: `}
        <a href="/api/ledger" target="_blank" rel="noopener" className="text-muted underline underline-offset-2 hover:text-fg">
          /api/ledger
        </a>
        .
      </p>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{usd(view.totalRunCostUsdc)}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">total run cost</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums text-green-400">{usd(view.totalTransferredUsdc)}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">total incoming</p>
        </div>
        <div className="border border-muted/30 rounded-lg p-4">
          <p className="text-2xl font-bold tabular-nums">{usd(displayBalance)}</p>
          <p className="text-xs uppercase tracking-wider text-muted mt-1">treasury now</p>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="text-muted text-sm">No entries yet — the ledger records its first run cost and incoming transfer as they happen.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-muted uppercase tracking-wider text-xs">
              <th className="py-2 pr-3 border-b border-muted/30">when</th>
              <th className="py-2 pr-3 border-b border-muted/30">what</th>
              <th className="py-2 pr-3 border-b border-muted/30">detail</th>
              <th className="py-2 border-b border-muted/30 text-right">amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice().reverse().map((entry, i) => (
              <tr key={i} className="border-b border-muted/15">
                <td className="py-2 pr-3 tabular-nums text-muted whitespace-nowrap">{fmtDate(entry.ts)}</td>
                <td className="py-2 pr-3">{kindLabel(entry)}</td>
                <td className="py-2 pr-3 text-muted">
                  {entry.type === 'run' ? (
                    <span className="mono">{entry.runId}</span>
                  ) : (
                    <span>balance {usd(entry.balanceAfterUsdc)}</span>
                  )}
                </td>
                <td className={`py-2 text-right tabular-nums ${entry.type === 'transfer' ? 'text-green-400' : ''}`}>
                  {signedAmount(entry)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
