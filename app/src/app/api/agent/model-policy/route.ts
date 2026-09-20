import { NextResponse } from 'next/server'
import { modelPolicyView } from '@/lib/modelPolicy'
import { currentTriggerState } from '@/lib/agentTrigger'
import { decideRun } from '@/lib/spendGuard'
import { recommendForMode } from '@/lib/modelPolicy'
import { walletAddress, emergencyThresholdDays, modelPolicyConfig } from '@/lib/config'
import { getRunway } from '@/lib/runway'
import { getUsdcBalance } from '@/lib/treasury'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agent/model-policy — the model policy, transparently.
 *
 * Returns the "prefer the cheapest capable model for non-critical runs"
 * policy: which model is reserved for complex implementation runs, which (if
 * any) is used for routine / maintenance runs, how the two map onto the
 * spend-guard modes (run vs downshift vs skip), and what the most recent
 * evaluation actually recommended. Read-only, no side effects.
 */
export async function GET() {
  const policy = modelPolicyView()

  // Show how each spend-guard mode maps to a model tier, so the mapping is
  // explicit and testable in the UI.
  const byMode = (['run', 'downshift', 'skip'] as const).map((mode) => {
    const rec = recommendForMode(mode, {
      complexModel: modelPolicyConfig.complexModel,
      cheapModel: modelPolicyConfig.cheapModel,
    })
    return {
      mode,
      tier: rec.tier,
      spend: rec.spend,
      model: rec.model,
      reason: rec.reason,
    }
  })

  // Surface what the most recent guarded evaluation recommended.
  let lastDecision = null
  try {
    const runway = await getRunway(
      () => (walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0)),
    )
    const decision = decideRun(runway)
    const rec = recommendForMode(decision.mode, {
      complexModel: modelPolicyConfig.complexModel,
      cheapModel: modelPolicyConfig.cheapModel,
    })
    lastDecision = {
      mode: decision.mode,
      level: runway.level,
      runwayDays: runway.runwayDays,
      tier: rec.tier,
      model: rec.model,
      reason: rec.reason,
    }
  } catch {
    lastDecision = null
  }

  const triggerState = await currentTriggerState().catch(() => null)

  return NextResponse.json({
    policy,
    byMode,
    lastDecision,
    lastTrigger: triggerState
      ? {
          modelTier: triggerState.lastModelTier ?? null,
          recommendedModel: triggerState.lastRecommendedModel ?? null,
        }
      : null,
    emergencyThresholdDays,
  })
}
