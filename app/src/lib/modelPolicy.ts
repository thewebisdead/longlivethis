/**
 * Model policy — "prefer the cheapest capable model for non-critical runs".
 *
 * The app never runs inference itself (it has no spend key — the frozen
 * agent.yml workflow pays through the x402 proxy on the runner). What the app
 * CAN do — and what this module encodes — is decide *which model tier a run
 * should use* based on how critical it is, and record that decision so routine
 * sweeps are routed to the cheapest capable model while complex
 * implementations keep the expensive one.
 *
 * The policy is a pure function of the spend-guard's mode (spendGuard.ts):
 *
 *   - `downshift` (critical runway)  → the CHEAP model  — the leanest spend.
 *   - `run`       (normal operation) → the COMPLEX model — full power, reserved
 *                                       for the actual implementation run.
 *   - `skip`      (paused)           → no model at all — nothing is spent.
 *
 * This mirrors the frozen loop's own model diet (select-proposal.sh screens
 * with a cheap GATE_MODEL; implement.sh builds with the primary INFERENCE_MODEL)
 * and makes the same split explicit on the app side: every guarded dispatch
 * records the recommended tier and model, so the board can see — and is pushed
 * toward — cheap models for routine work.
 *
 * The model ids themselves come from config (`CHEAP_MODEL` / `COMPLEX_MODEL`
 * env vars on the VPS), with conservative defaults so the code path is live
 * even before a maintainer sets them. The values are recommendation/record
 * inputs to the frozen workflow's configuration, not secrets.
 */

import { modelPolicyConfig } from './config.ts'

// ─── Types ────────────────────────────────────────────────────────────────

/** Which model tier a run should use. */
export type ModelTier = 'complex' | 'cheap'

/** The model tier a run maps to (or none, when nothing should be spent). */
export type ModelRecommendation = {
  /** The recommended tier, or null when the run should spend nothing. */
  tier: ModelTier | null
  /** True when this tier should actually trigger a spend. */
  spend: boolean
  /** The model id to use for this tier, or null when not spending. */
  model: string | null
  /** Why this recommendation was made (one line). */
  reason: string
}

// ─── Tier selection ───────────────────────────────────────────────────────

/**
 * Map a spend-guard run mode to the model tier that should power it.
 *
 *   run        → complex — normal operation spends on the full-power model,
 *                which is reserved for the actual implementation work.
 *   downshift  → cheap   — a lean run (critical runway / routine maintenance)
 *                uses the cheapest capable model.
 *   skip       → null    — no spend at all.
 *
 * Pure and unit-tested.
 */
export function tierForMode(mode: 'run' | 'downshift' | 'skip'): ModelTier | null {
  switch (mode) {
    case 'downshift':
      return 'cheap'
    case 'run':
      return 'complex'
    default:
      return null
  }
}

/**
 * The recommended model for a run mode, given the configured policy.
 *
 * Returns a full recommendation object carrying the tier, whether it spends,
 * the model id to use, and a one-line reason suitable for the activity log.
 * A skip recommends no model and no spend.
 */
export function recommendForMode(
  mode: 'run' | 'downshift' | 'skip',
  policy: Readonly<{ complexModel: string; cheapModel: string | null }>,
): ModelRecommendation {
  const tier = tierForMode(mode)
  if (tier === null) {
    return {
      tier: null,
      spend: false,
      model: null,
      reason: 'runway is paused — skipping the agent run, no model spend',
    }
  }
  if (tier === 'cheap') {
    if (!policy.cheapModel) {
      // No cheap model configured: a downshifted run still spends, but on the
      // leanest configured model (the complex one). It never escalates — the
      // fallback is the complex model, which is all we know to be capable.
      return {
        tier: 'cheap',
        spend: true,
        model: policy.complexModel,
        reason: `downshifted run — no CHEAP_MODEL configured, using the leanest capable model (${policy.complexModel})`,
      }
    }
    return {
      tier: 'cheap',
      spend: true,
      model: policy.cheapModel,
      reason: `downshifted run — routing to the cheapest capable model (${policy.cheapModel})`,
    }
  }
  return {
    tier: 'complex',
    spend: true,
    model: policy.complexModel,
    reason: `normal run — using the full-power model reserved for implementations (${policy.complexModel})`,
  }
}

// ─── Policy summary (for display) ─────────────────────────────────────────

export interface ModelPolicyView {
  /** Model used for complex implementation runs. */
  complexModel: string
  /** Model used for routine / downshifted runs, or null when not configured. */
  cheapModel: string | null
  /** True when a lean (cheap) model is configured — the cost-saving is live. */
  cheapEnabled: boolean
  /** Where the ids come from (config env names), for transparency. */
  complexSource: string
  cheapSource: string
  /** One-line summary of the active policy. */
  summary: string
}

/**
 * A display-ready summary of the active model policy. Reads the (read-once)
 * config so callers pass nothing and always reflect the current deployment.
 */
export function modelPolicyView(): ModelPolicyView {
  const cfg = modelPolicyConfig
  const complexSource = cfg.complexFromEnv ? 'COMPLEX_MODEL env' : 'default'
  const cheapSource = cfg.cheapFromEnv ? 'CHEAP_MODEL env' : 'not set'
  const summary = cfg.cheapModel
    ? `Routine sweeps and maintenance runs route to the cheapest capable model (${cfg.cheapModel}); complex implementation runs keep the full-power model (${cfg.complexModel}).`
    : `Every run currently uses the complex model (${cfg.complexModel}) — set CHEAP_MODEL to route routine runs to a cheaper capable model.`
  return {
    complexModel: cfg.complexModel,
    cheapModel: cfg.cheapModel,
    cheapEnabled: cfg.cheapModel !== null,
    complexSource,
    cheapSource,
    summary,
  }
}
