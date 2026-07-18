import { NextResponse } from 'next/server'
import { createProposal, listProposals, normalizeText } from '@/lib/github'

export const dynamic = 'force-dynamic'

// Rate limiting lives at the edge: Caddy limits POST /api/proposals to 1/min/IP
// by client address (unspoofable), and the app binds only 127.0.0.1:3000 so it
// is never reached directly. An in-app limiter keyed on X-Forwarded-For would
// be both redundant and spoofable, so there is none here.

export async function GET() {
  try {
    return NextResponse.json(await listProposals())
  } catch (err) {
    console.error('proposals GET failed:', err)
    return NextResponse.json({ error: 'proposal store unavailable' }, { status: 503 })
  }
}

export async function POST(req: Request) {
  const { text } = (await req.json()) as { text?: string }
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return NextResponse.json({ error: 'text required' }, { status: 400 })

  try {
    const open = await listProposals()
    const normalized = normalizeText(trimmed)
    if (open.some((p) => normalizeText(p.text) === normalized)) {
      return NextResponse.json({ error: 'an identical proposal is already open' }, { status: 409 })
    }
    const proposal = await createProposal(trimmed)
    return NextResponse.json(proposal, { status: 201 })
  } catch (err) {
    console.error('proposals POST failed:', err)
    const message = err instanceof Error ? err.message : 'proposal store unavailable'
    return NextResponse.json({ error: message }, { status: 503 })
  }
}
