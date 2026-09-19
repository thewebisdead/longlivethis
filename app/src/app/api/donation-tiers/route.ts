import { NextResponse } from 'next/server'
import {
  DONATION_TIERS,
  listTierClaims,
  claimTier,
  recognitionStrip,
} from '@/lib/donationTiers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/donation-tiers — the tier ladder plus live recognition.
 *
 * Returns:
 *   {
 *     tiers: DonationTier[],
 *     claims: TierClaim[],
 *     strip: { founders, sponsors, badges } // recognition grouped for rendering
 *   }
 */
export async function GET() {
  try {
    const claims = await listTierClaims()
    return NextResponse.json({
      tiers: DONATION_TIERS,
      claims,
      strip: recognitionStrip(claims),
    })
  } catch (err) {
    console.error('donation-tiers GET failed:', err)
    return NextResponse.json({ error: 'donation tiers unavailable' }, { status: 503 })
  }
}

/**
 * POST /api/donation-tiers — claim a reward tier.
 *
 * Self-attesting acknowledgement: the supporter says which tier they funded
 * and the name to recognize. Body: { tierId, name, address? }
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const tierId = body.tierId
  const name = body.name
  const address = body.address

  if (typeof tierId !== 'string') {
    return NextResponse.json({ error: 'tierId required' }, { status: 400 })
  }
  if (typeof name !== 'string') {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }

  try {
    const claim = await claimTier({
      tierId,
      name,
      address: typeof address === 'string' ? address : undefined,
    })
    return NextResponse.json(claim, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid claim'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
