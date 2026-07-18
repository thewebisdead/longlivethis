import { NextResponse } from 'next/server'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? ''

// Returns an SVG badge with the current USDC treasury balance.
// Compatible with shields.io endpoint format — also usable directly as <img src>.
export async function GET() {
  let label = 'treasury'
  let message = 'N/A'
  let color = 'lightgrey'

  if (WALLET_ADDRESS) {
    const balance = await getUsdcBalance(WALLET_ADDRESS).catch(() => null)
    if (balance !== null) {
      message = `$${balance.toFixed(2)} USDC`
      if (balance >= 10) color = '2ecc71' // green
      else if (balance >= 1) color = 'f39c12' // orange
      else color = 'e74c3c' // red — critically low
    }
  }

  // Rough text width estimate: ~6.5px per char for the default font
  const labelWidth = Math.round(label.length * 6.5 + 10)
  const messageWidth = Math.round(message.length * 6.5 + 10)
  const totalWidth = labelWidth + messageWidth

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="#${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${Math.round(labelWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${Math.round(labelWidth / 2)}" y="14">${label}</text>
    <text x="${labelWidth + Math.round(messageWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${message}</text>
    <text x="${labelWidth + Math.round(messageWidth / 2)}" y="14">${message}</text>
  </g>
</svg>`

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache, max-age=60',
    },
  })
}
