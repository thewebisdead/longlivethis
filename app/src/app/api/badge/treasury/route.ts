import { NextResponse } from 'next/server'
import { walletAddress } from '@/lib/config'
import { getUsdcBalance } from '@/lib/treasury'
import { renderBadge } from '@/lib/badge'

export const dynamic = 'force-dynamic'

// A self-hosted SVG badge for the README: ![treasury](https://<deployment>/api/badge/treasury)
// GitHub's README renderer fetches the <img src> live on every view, so this
// is a normal cached GET — no separate setup, no external badge service, no
// key needed. It rides the same USDC read (and its 60s cache) the homepage
// already uses, so a badge view costs no extra RPC call.

export async function GET() {
  const message = walletAddress
    ? await getUsdcBalance(walletAddress)
        .then((balance) => `$${balance.toFixed(2)} USDC`)
        .catch(() => 'unknown')
    : 'unconfigured'

  const svg = renderBadge('treasury', message, { color: message === 'unknown' || message === 'unconfigured' ? '#999' : '#4c1' })

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      // Badges are meant to look live: no long-lived caching at the edge or in
      // the client, even though the value itself is cached server-side for 60s.
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    },
  })
}
