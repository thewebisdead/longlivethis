import { NextResponse } from 'next/server'
import { createProposal, listProposals, normalizeText } from '@/lib/github'

export const dynamic = 'force-dynamic'

// Proposal intake only — reading the feed is the homepage's job (it server-
// renders `listProposals()` directly), so there is no GET here.
//
// Rate limiting lives at the edge: Caddy limits POST /api/proposals to 1/min/IP
// by client address (unspoofable), and the app binds only 127.0.0.1:3000 so it
// is never reached directly. An in-app limiter keyed on X-Forwarded-For would
// be both redundant and spoofable, so there is none here.

export async function POST(req: Request) {
  // Body parsing gets its own guard rather than sharing the try below: a
  // malformed body is a client error, not the 503 "store unavailable" that the
  // GitHub calls report. Unguarded, both `req.json()` on non-JSON and `.trim()`
  // on a non-string `text` throw straight out of the handler as an opaque 500.
  let trimmed: string
  try {
    const { text } = (await req.json()) as { text?: unknown }
    trimmed = typeof text === 'string' ? text.trim() : ''
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
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
