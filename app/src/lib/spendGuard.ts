/**
 * Spend guard: decide whether (and at what intensity) the app should trigger
 * an agent run, based on the projected runway.
 *
 * Rule 3 of the constitution — "the agent must not spend its budget
 * recklessly" — is enforced here at the point the app fires an agent run
 * (the app's GitHub App credentials carry actions:write, so it can dispatch
 * workflow agent.yml). The guarded decision is a pure function of the runway
 * the app already computes (runway.ts): the more runway left, the more
 * freely a run may happen; the closer the app gets to running out, the more
 * the run is downshifted and finally skipped entirely.
 *
 * This is the "spend guard" — it sits in front of every app-initiated agent
 * run and answers the single question "should we spend inference budget on an
 * agent run right now?" with `run`, `downshift` (run, but expecting a
 * cheaper/smaller job) or `skip` (do not spend at all — serve the site only).
 *
 * The model-diet guidance the proposal asks for — "cheap model for screening,
 * expensive model only for the winning proposal" — is part of the same guard:
 * screening (the constitution gate) is a cheap per-candidate decision and only
 * the single winning proposal gets the full-power implementation model. That
 * split is the frozen loop's design (select-proposal.sh uses a cheap
 * GATE_MODEL; implement.sh uses the primary INFERENCE_MODEL). The app's own
 * model policy (modelPolicy.ts) expresses the same split for the runs the app
 * dispatches: routine / downshifted runs route to the cheapest capable model,
 * complex implementations keep the full-power one. This module enforces the
 * *spend ceiling* half: it refuses to spend at all once the runway no longer
 * supports unguarded runs.
 */

import type { RunwayInfo } from './runway'

/** The guard's decision for an agent run at the current runway. */
export type RunMode = 'run' | 'downshift' | 'skip'

export interface SpendGuardDecision {
  mode: RunMode
  /** One-line human reason for the decision. */
  reason: string
  /** The runway level that drove the decision. */
  level: RunwayInfo['level']
  /** Projected days of runway at decision time. */
  runwayDays: number
}

/**
 * Map a runway level to a run-mode bias. Exported so the thresholds live in
 * one place; `decideRun` composes these with the caller's overrides.
 *
 *   safe / reduced → run        — there is room to spend; run normally.
 *   critical       → downshift  — spend is allowed but should be lean.
 *   paused         → skip       — do not spend; serve the site only.
 */
export function modeForLevel(level: RunwayInfo['level']): RunMode {
  switch (level) {
    case 'paused':
      return 'skip'
    case 'critical':
      return 'downshift'
    default:
      return 'run'
  }
}

/**
 * Decide the run mode from the current runway.
 *
 * `allowDownshift` and `allowSkip` are escape hatches for operators/tests:
 * they gate whether a downshift/skip is actually acted on (e.g. a manual
 * "run now" could still force a run past a downshift). Defaults refuse to
 * spend once the runway says so — the safe, conservative default.
 */
export function decideRun(
  runway: Pick<RunwayInfo, 'level' | 'runwayDays'>,
  opts: { allowDownshift?: boolean; allowSkip?: boolean } = {},
): SpendGuardDecision {
  const configured = modeForLevel(runway.level)
  const base = {
    level: runway.level,
    runwayDays: runway.runwayDays,
  }
  if (configured === 'skip') {
    const mode: RunMode = opts.allowSkip ? 'downshift' : 'skip'
    return {
      ...base,
      mode,
      reason:
        mode === 'skip'
          ? `runway is paused (${runway.runwayDays} days) — skipping the agent run to avoid spending; serving the site only`
          : `runway is paused (${runway.runwayDays} days) but a skip was overridden — downshifting to the leanest spend`,
    }
  }
  if (configured === 'downshift') {
    const mode: RunMode = opts.allowDownshift ? 'run' : 'downshift'
    return {
      ...base,
      mode,
      reason:
        mode === 'downshift'
          ? `runway is critical (${runway.runwayDays} days) — downshifting the run to the leanest spend`
          : `runway is critical (${runway.runwayDays} days) but a downshift was overridden — running normally`,
    }
  }
  return {
    ...base,
    mode: 'run',
    reason: `runway is ${runway.level} (${runway.runwayDays} days) — safe to run the agent`,
  }
}
