// Dynamic Open Graph share card.
//
// One route generates the share image for the whole site. It renders the
// current treasury balance and the runway (estimated days left), and — when
// given a `proposal` query param — that proposal's title. The card is rendered
// fresh on every request against the (cached) on-chain balance and proposal
// list, so a link shared at any moment carries live state.
//
// Referred to by metadata (layout.tsx) as the homepage og:image and usable
// directly as /api/og. Social scrapers fetch it when a link is pasted, which is
// the site's distribution channel — so the card is designed to read well as a
// 1200x630 link preview with the numbers front and centre.
//
// The image is PNG, generated server-side by next/og (satori + resvg). It is
// cached briefly so a scrape surge does not hammer the RPC, but short enough
// that re-sharing a card yields fresh numbers.

import { ImageResponse } from 'next/og'
import { walletAddress } from '@/lib/config'
import { getUsdcBalance } from '@/lib/treasury'
import { getRunway } from '@/lib/runway'
import { listProposals } from '@/lib/github'

export const dynamic = 'force-dynamic'

const WIDTH = 1200
const HEIGHT = 630

const SITE = 'longlivethis.site'

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Truncate a proposal title to what fits cleanly on the card.
function clampTitle(title: string, max = 80): string {
  const t = title.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const proposalId = Number(url.searchParams.get('proposal'))
  const wantProposal = Number.isInteger(proposalId) && proposalId > 0

  // Resolve live state. Each read is independently resilient: an RPC blip shows
  // "…" for the balance rather than failing the card; an empty board falls back
  // to a generic line. Never block a share card on an unavailable source.
  const [balance, runway, proposals] = await Promise.all([
    walletAddress ? getUsdcBalance(walletAddress).catch(() => null) : Promise.resolve(null),
    getRunway(() =>
      walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0)
    ).catch(() => null),
    listProposals().catch(() => []),
  ])

  const balanceText = balance === null ? '…' : formatUsd(balance)

  let runwayText = '—'
  let runwayColor = '#888'
  if (runway != null) {
    if (runway.runwayDays === Infinity || !Number.isFinite(runway.runwayDays)) {
      runwayText = 'runway: ∞'
      runwayColor = '#fff'
    } else {
      const days = Math.floor(runway.runwayDays)
      runwayText = `dies in ${days} days`
      runwayColor = runway.level === 'safe' ? '#facc15' : runway.level === 'reduced' ? '#fb923c' : '#f87171'
    }
  }

  const topProposal = wantProposal
    ? proposals.find((p) => p.id === proposalId)
    : undefined

  const proposalCount = proposals.length
  const headline = wantProposal
    ? topProposal
      ? clampTitle(topProposal.title)
      : 'proposal not found'
    : `${proposalCount} open ${proposalCount === 1 ? 'proposal' : 'proposals'} · funding the web`

  const voteRef = topProposal
    ? `votes ${topProposal.votes >= 0 ? '+' : ''}${topProposal.votes}`
    : ''

  const res = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#000',
          color: '#fff',
          padding: '64px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {/* Top row: identity + proposal context */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ fontSize: 28, color: '#888', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
            {SITE}
          </div>
          {wantProposal && (
            <div style={{ fontSize: 24, color: '#888' }}>
              proposal <span style={{ color: '#fff' }}>#{proposalId}</span>
            </div>
          )}
        </div>

        {/* Headline — the proposal title or the board summary */}
        <div style={{ fontSize: 60, fontWeight: 700, lineHeight: 1.1, maxWidth: 1000, color: '#fff' }}>
          {headline}
        </div>

        {/* Numbers — the reason the card exists */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ fontSize: 112, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {balanceText}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <div style={{ fontSize: 32, color: runwayColor }}>{runwayText}</div>
            {voteRef && <div style={{ color: '#888', fontSize: 24 }}>{voteRef}</div>}
            <div style={{ color: '#888', fontSize: 22, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              treasury · USDC
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
    }
  )

  // Cache briefly so a scrape surge does not hammer the RPC, but short enough
  // that re-sharing a card yields fresh numbers. `public` lets CDN/proxy caches
  // (Cloudflare in front of Caddy) serve it; `max-age` bounds that freshness.
  res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300')
  return res
}
