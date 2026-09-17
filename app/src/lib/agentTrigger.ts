/**
 * Agent trigger: the app-initiated dispatch of workflow agent.yml, guarded by
 * the spend guard (spendGuard.ts).
 *
 * The app's GitHub App credentials include actions:write (see config.ts), so
 * app code may dispatch the frozen agent workflow. This is where the spend
 * guard becomes real: instead of firing a run unconditionally, the app checks
 * the runway first and refuses to spend (skip) or asks for a lean run
 * (downshift) when the projected runway no longer supports an unguarded one.
 *
 * Cadence is enforced in-app so traffic-driven triggering cannot fire a run
 * more often than intended: the last attempt's timestamp is recorded on the
 * durable state volume and re-dispatching is refused until the cadence has
 * passed. The frozen agent.yml hourly cron still runs independently; this is
 * the app's own guarded path, so the guard governs every run the app starts.
 *
 * Nothing here holds a spend key — dispatching a workflow only schedules it;
 * the actual inference is paid by the frozen loop on the runner. A refusal
 * (skip) is the point: no dispatch means no spend.
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { github, githubAppConfigured, walletAddress, emergencyThresholdDays } from './config.ts'
import { getRunway } from './runway.ts'
import { getUsdcBalance } from './treasury.ts'
import { decideRun } from './spendGuard.ts'
import {
  evaluateSurvivalMode,
  recordSkippedRun,
  recordDownshiftedRun,
} from './survival.ts'
import type { SpendGuardDecision } from './spendGuard'
import type { SurvivalLevel } from './survival'

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * How long to wait between app-initiated agent runs, in milliseconds.
 * Defaults to 60 minutes (matching the frozen hourly sweep cadence); the app
 * never fires a run more often than this.
 */
export const DEFAULT_CADENCE_MS = 60 * 60 * 1000

/**
 * Path to the trigger state file on the durable state volume. Overridable for
 * tests.
 */
let triggerPath = '/var/lib/longlive/state/agent-trigger.json'

export function setAgentTriggerPath(path: string): void {
  triggerPath = path
}

export function getAgentTriggerPath(): string {
  return triggerPath
}

// ─── Trigger state ────────────────────────────────────────────────────────

export interface TriggerState {
  /** Unix ms of the last time we attempted a guard + dispatch. */
  lastAttemptTs: number | null
  /** Unix ms of the last time we actually dispatched a run. */
  lastDispatchTs: number | null
  /** Mode of the last decision. */
  lastMode: 'run' | 'downshift' | 'skip' | null
  /** Run id of the last dispatch, if any. */
  lastRunId: string | null
  /** Runway (days) at the last decision. */
  lastRunwayDays: number | null
  /** Human reason from the last decision. */
  lastReason: string | null
}

export const EMPTY_TRIGGER_STATE: TriggerState = {
  lastAttemptTs: null,
  lastDispatchTs: null,
  lastMode: null,
  lastRunId: null,
  lastRunwayDays: null,
  lastReason: null,
}

export function parseTriggerState(data: string): TriggerState {
  if (!data.trim()) return { ...EMPTY_TRIGGER_STATE }
  const parsed = JSON.parse(data) as Partial<TriggerState>
  return {
    lastAttemptTs: typeof parsed.lastAttemptTs === 'number' ? parsed.lastAttemptTs : null,
    lastDispatchTs: typeof parsed.lastDispatchTs === 'number' ? parsed.lastDispatchTs : null,
    lastMode: parsed.lastMode === 'run' || parsed.lastMode === 'downshift' || parsed.lastMode === 'skip'
      ? parsed.lastMode
      : null,
    lastRunId: typeof parsed.lastRunId === 'string' ? parsed.lastRunId : null,
    lastRunwayDays: typeof parsed.lastRunwayDays === 'number' ? parsed.lastRunwayDays : null,
    lastReason: typeof parsed.lastReason === 'string' ? parsed.lastReason : null,
  }
}

export function serializeTriggerState(state: TriggerState): string {
  return JSON.stringify(state) + '\n'
}

async function readTriggerState(): Promise<TriggerState> {
  try {
    const data = await readFile(triggerPath, 'utf8')
    return parseTriggerState(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_TRIGGER_STATE }
    }
    console.error('agentTrigger: failed to read trigger state:', err)
    return { ...EMPTY_TRIGGER_STATE }
  }
}

async function writeTriggerState(state: TriggerState): Promise<void> {
  const dir = triggerPath.substring(0, triggerPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = triggerPath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeTriggerState(state), 'utf8')
  await rename(tmp, triggerPath)
}

// ─── GitHub dispatch helper ───────────────────────────────────────────────

/**
 * Authenticated POST to a GitHub API path, using the proposals app token
 * (or the static PAT fallback from config).
 *
 * On the VPS, `GITHUB_TOKEN` in `app.env` is the proposals app's fine-grained
 * token with issues:write + actions:write, so it can dispatch the frozen
 * agent.yml workflow. This is the credential available on the VPS that makes
 * the self-trigger possible.
 */
async function ghPost(apiBase: string, path: string, body: unknown): Promise<Response> {
  const token = github.token || ''
  return fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
}

/**
 * Return the token + API base + repo path for dispatching, or null when
 * GitHub is not configured (preview, no creds).
 *
 * Dispatch needs GITHUB_REPO (owner/name) from config AND a token that can
 * POST to /repos/:owner/:repo/actions/workflows/agent.yml/dispatches.
 * On the VPS, GITHUB_TOKEN is the proposals app's PAT with actions:write.
 * When only the App credential is configured (no PAT), dispatch is
 * unavailable — the App's installation token needs to be minted by github.ts's
 * internal helpers, and this module avoids depending on that internal.
 */
function getGhDispatchTarget(): { token: string; apiBase: string; repo: string } | null {
  const repo = github.repo
  if (!repo) return null
  // Static PAT (the default VPS path): GITHUB_TOKEN in app.env.
  if (github.token) return { token: github.token, apiBase: github.apiBase, repo }
  // App-configured but no PAT: we cannot mint a token without github.ts' internal
  // helpers, and this module keeps its deps light. Return null.
  return null
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

export interface DispatchResult {
  decision: SpendGuardDecision
  /** true if a workflow dispatch was actually POSTed. */
  dispatched: boolean
  /** Cadence suppressed the attempt (it is not yet time to run again). */
  throttled: boolean
  /** Whether we were even able to check the runway (balance read ok). */
  runwayRich: boolean
  /** Workflow run id for a dispatch, else null. */
  runId: string | null
  /** Error message when dispatch itself failed, else null. */
  error: string | null
  /** Current emergency survival mode level. */
  survivalLevel: SurvivalLevel
  /** Emergency threshold in days that drove the mode. */
  emergencyThresholdDays: number
}

/**
 * A short run id for the ledger/mirror. Not a trailing-slash-sensitive path
 * segment, so a simple random hex works.
 */
function newRunId(): string {
  return `run-${Date.now()}-${randomBytes(3).toString('hex')}`
}

/**
 * Run the guarded trigger pipeline: read runway, consult the spend guard,
 * respect the cadence, and dispatch agent.yml only when the guard allows.
 *
 * This is safe to call on every page render — cadence throttling means it
 * only acts as often as the configuration allows.
 */
export async function runGuardedTrigger(
  opts: { cadenceMs?: number; force?: boolean } = {},
): Promise<DispatchResult> {
  const state = await readTriggerState()
  const now = Date.now()
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CADENCE_MS

  // Read the runway. If the treasury/RPC is unreachable we treat it as
  // runway 0 → paused → skip (the conservative, expensive-safe reading).
  let runway: { level: 'safe' | 'reduced' | 'critical' | 'paused'; runwayDays: number; dailyBurn: number }
  let runwayRich = true
  try {
    const info = await getRunway(
      () => (walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0))
    )
    runway = { level: info.level, runwayDays: info.runwayDays, dailyBurn: info.dailyBurn }
    runwayRich = true
  } catch {
    runway = { level: 'paused', runwayDays: 0, dailyBurn: 0 }
    runwayRich = false
  }

  // Evaluate emergency survival mode first — this determines whether we are
  // in an emergency/critical/paused state and reduces spend accordingly.
  const survivalState = await evaluateSurvivalMode(runway, emergencyThresholdDays)
  const survivalLevel = survivalState.level

  // In emergency/critical/paused modes the cadence tightens so unnecessary
  // runs fire less often — fewer runs, less burn. The spend guard still
  // decides run vs downshift vs skip on top of that.
  const effectiveCadence = (() => {
    if (survivalLevel === 'paused') return DEFAULT_CADENCE_MS * 6 // 6h — effectively a single daily window
    if (survivalLevel === 'critical') return DEFAULT_CADENCE_MS * 3 // 3h
    if (survivalLevel === 'emergency') return DEFAULT_CADENCE_MS * 2 // 2h
    return cadenceMs
  })()

  // Cadence: don't re-attempt until the cadence has elapsed since the last
  // attempt, unless force is set (a manual run-now).
  const throttled = !opts.force &&
    state.lastAttemptTs !== null &&
    now - state.lastAttemptTs < effectiveCadence

  const decision = decideRun(runway)

  // Record the attempt (even when throttled — we still evaluated runway).
  const nextState: TriggerState = {
    ...state,
    lastAttemptTs: now,
    lastMode: decision.mode,
    lastRunwayDays: runway.runwayDays,
    lastReason: decision.reason,
  }

  const result: DispatchResult = {
    decision,
    dispatched: false,
    throttled,
    runwayRich,
    runId: null,
    error: null,
    survivalLevel,
    emergencyThresholdDays,
  }

  if (throttled) {
    await writeTriggerState(nextState)
    return result
  }

  // Skip: no dispatch, no spend. Record (for survival tracking) and stop.
  if (decision.mode === 'skip') {
    if (['emergency', 'critical', 'paused'].includes(survivalLevel)) {
      await recordSkippedRun().catch(() => null)
    }
    await writeTriggerState(nextState)
    return result
  }

  // Downshift: record it for survival tracking.
  if (decision.mode === 'downshift') {
    await recordDownshiftedRun().catch(() => null)
  }

  // Run or downshift: dispatch the frozen agent workflow. In emergency mode
  // the dispatch only happens for lean runs (already enforced above by the
  // spend guard and the tightened cadence); the workflow itself is untouched.
  const target = getGhDispatchTarget()
  if (!target) {
    result.error = 'GitHub credentials not configured — cannot dispatch agent.yml'
    await writeTriggerState(nextState)
    return result
  }

  const runId = newRunId()
  try {
    const res = await ghPost(
      target.apiBase,
      `/repos/${target.repo}/actions/workflows/agent.yml/dispatches`,
      { ref: 'main' },
    )
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message
      result.error = `GitHub dispatch failed: ${res.status}${detail ? ` — ${detail}` : ''}`
    } else {
      result.dispatched = true
      result.runId = runId
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'github dispatch threw'
  }

  nextState.lastDispatchTs = result.dispatched ? now : nextState.lastDispatchTs
  nextState.lastRunId = result.dispatched ? runId : nextState.lastRunId
  await writeTriggerState(nextState)
  return result
}

/**
 * The current trigger state (no side-effects — just reads the persisted file).
 * Returns EMPTY_TRIGGER_STATE when there is no recorded state yet (first boot).
 */
export async function currentTriggerState(): Promise<TriggerState> {
  return readTriggerState()
}
