import { NextResponse } from 'next/server'
import { getSuggestions, requestRegenerate, readSuggestionState } from '@/lib/proposalSuggester'

export const dynamic = 'force-dynamic'

/**
 * GET /api/suggestions — the current batch of auto-generated proposal
 * suggestions. Regenerates lazily when the cached batch is empty. Read-only.
 * Shape:
 *
 *   {
 *     suggestions: [{ title, description, reason, lever }],
 *     generatedAt: number | null,
 *     context: { balanceUsdc, runwayDays, openCount }
 *   }
 */
export async function GET() {
  const ctx = await readSuggestionState()
  const { suggestions, generatedAt } = await getSuggestions(ctx)
  return NextResponse.json({
    suggestions,
    generatedAt,
    context: {
      balanceUsdc: ctx.balanceUsdc,
      runwayDays: ctx.runwayDays,
      openCount: ctx.proposals.length,
    },
  })
}

/**
 * POST /api/suggestions — request an immediate regeneration of suggestions.
 * Rate-limited by REGENERATE_COOLDOWN_MS. Returns the current batch and
 * whether a new batch was produced.
 */
export async function POST() {
  const ctx = await readSuggestionState()
  const { ok, suggestions, generatedAt } = await requestRegenerate(ctx)
  return NextResponse.json({ ok, suggestions, generatedAt })
}
