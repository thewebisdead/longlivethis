import { NextResponse } from 'next/server'
import {
  createProposal,
  listProposals,
  normalizeText,
  PROPOSAL_HARD_CAP,
} from '@/lib/github'

export const dynamic = 'force-dynamic'

// Proposal intake only — reading the feed is the homepage's job (it server-
// renders `listProposals()` directly), so there is no GET here.
//
// Rate limiting lives at the edge: a Cloudflare ruleset (written once at init
// by the create-longlive CLI, not from this repo) limits POST /api/proposals
// to 1 per 10s per IP per colo.
// An in-app limiter keyed on X-Forwarded-For would be spoofable, so there is
// none here.

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
    // The board is finite, and this is where that is enforced. Refusing here is
    // what lets every reader of the board fetch it in a bounded number of pages
    // instead of crawling an open-ended list.
    //
    // In practice nobody meets this: the cleanup workflow keeps the board near
    // CLEANUP_THRESHOLD (default 100) by closing the lowest-ranked proposals,
    // so 500 is only reachable by a burst that outran a sweep. That is why the
    // cap is set well above the working size — the ceiling exists to bound the
    // work, not to ration proposals.
    if (open.length >= PROPOSAL_HARD_CAP) {
      return NextResponse.json(
        {
          error: `the proposal board is full (${PROPOSAL_HARD_CAP} open) — vote on what is open; the lowest-ranked proposals are closed automatically, then try again`,
        },
        { status: 409 }
      )
    }
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
