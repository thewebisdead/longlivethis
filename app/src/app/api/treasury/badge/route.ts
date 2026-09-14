// Dynamic SVG badge reflecting the current USDC treasury balance.
//
// Serves a shields.io-style badge (flat style) with the balance inline.
// The image is uncacheable (no-store) so the badge on the README reflects
// the latest balance on every page load a cache or proxy forwards.
//
// Visit /api/treasury/badge in a browser to see it; embed it in the README
// with <img src="https://longlivethis.site/api/treasury/badge" />.

import { NextResponse } from 'next/server'
import { walletAddress } from '@/lib/config'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

function badgeSvg(label: string, value: string, color: string): string {
  // Approximate metrics: 7px per character for the label, 7px per character
  // for the value, plus padding. floor avoids fractional SVG widths.
  const lw = Math.floor(label.length * 7 + 10) // label width
  const vw = Math.floor(value.length * 7 + 10) // value width
  const total = lw + vw
  const lr = lw      // right edge of label
  const vr = vw      // value region width
  const h = 20       // badge height
  const r = 3        // corner radius

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" viewBox="0 0 ${total} ${h}">` +
    `<linearGradient id="s" x2="0" y2="1%"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${total}" height="${h}" rx="${r}" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${lr}" height="${h}" fill="#555"/>` +
    `<rect x="${lr}" width="${vr}" height="${h}" fill="${color}"/>` +
    `<rect width="${total}" height="${h}" fill="url(#s)"/>` +
    `</g>` +
    `<g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${Math.floor(lr / 2)}" y="15" text-anchor="middle">${escapeXml(label)}</text>` +
    `<text x="${lr + Math.floor(vw / 2)}" y="15" text-anchor="middle">${escapeXml(value)}</text>` +
    `</g>` +
    `</svg>`
  )
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function GET() {
  // No wallet configured → show a grey badge saying "unknown".
  if (!walletAddress) {
    return new NextResponse(
      badgeSvg('treasury', 'unknown', '#555'),
      { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  let balance: number
  try {
    balance = await getUsdcBalance(walletAddress)
  } catch {
    return new NextResponse(
      badgeSvg('treasury', 'error', '#e05d44'),
      { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  const color = balance > 0 ? 'green' : '#e05d44'
  const formatted = balance >= 1 ? `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${balance.toFixed(2)}`

  return new NextResponse(
    badgeSvg('treasury', formatted, color),
    { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store, max-age=0' } }
  )
}
