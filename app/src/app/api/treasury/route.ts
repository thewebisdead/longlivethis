import { NextResponse } from 'next/server'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? ''

export async function GET() {
  // balance_usdc: null = no wallet configured (local preview) or read failed.
  const balance = WALLET_ADDRESS ? await getUsdcBalance(WALLET_ADDRESS).catch(() => null) : null
  return NextResponse.json({ address: WALLET_ADDRESS, balance_usdc: balance })
}
