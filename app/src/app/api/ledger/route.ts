// Public ledger JSON — the raw, append-only history of run costs and incoming
// transfers. Served at /api/ledger for programmatic use and for the /ledger
// page to fetch. No auth — transparency is the point.
//
// The ledger lives at STATE_DIR/ledger.json on the durable state volume and is
// maintained by ledger.ts. This route just reads and serves it.

import { NextResponse } from 'next/server'
import { readLedger, summarize } from '@/lib/ledger'

export const dynamic = 'force-dynamic'

export async function GET() {
  const state = await readLedger()
  const view = summarize(state)
  // Never cache: the ledger should reflect the latest recorded entries on
  // every visit, so a stale cache never hides incoming transfers from view.
  return NextResponse.json(view, {
    status: 200,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
