/**
 * Public Agent Activity Log — the durable record the /agent page renders.
 *
 * Every time the app evaluates the treasury runway and decides whether (and at
 * what intensity) to run the agent, it appends a structured activity entry to
 * this log on the durable state volume (STATE_DIR/agent-activity.json). Each
 * entry records what the agent was about to do, why, and the state that drove
 * the decision:
 *
 *   - the guard decision (run / downshift / skip) and its reason
 *   - the runway and Emergency Survival Mode level at decision time
 *   - which proposals were on the board (the candidates the agent was choosing
 *     among)
 *   - the run id and workflow dispatch outcome when a run was started
 *
 * Together with the public ledger (ledger.ts — run costs + transfers) and the
 * live GitHub PR / CI / workflow data (github.ts), this is what the /agent page
 * and /api/agent/activity assemble into a public activity log: evaluations,
 * constitution-gate/decision checks, implementation attempts, costs, PRs, CI
 * results and deployments.
 *
 * Nothing here needs a key. The data is already public (the decision is a pure
 * function of runway the app computes; the proposal list is public issues).
 * Atomic writes (temp file + rename) so a concurrent state-volume copy never
 * catches a half-written file, and the entry count is capped so the file stays
 * well under the state carry limit.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

/** The mode the spend guard chose for a run. */
export type ActivityMode = 'run' | 'downshift' | 'skip'

/**
 * A single record of an agent evaluation / decision event.
 */
export interface AgentActivityEntry {
  /** Unix timestamp (ms) when the evaluation happened. */
  ts: number
  /** The spend-guard mode chosen: run, downshift, or skip. */
  mode: ActivityMode
  /** Human reason for the decision (from the spend guard). */
  reason: string
  /** Runway level at decision time ('safe' | 'reduced' | 'critical' | 'paused'). */
  level: string
  /** Projected runway in days at decision time. */
  runwayDays: number
  /** Emergency Survival Mode level ('normal' | 'watch' | 'emergency' | ...). */
  survivalLevel: string
  /** Whether the attempt was suppressed by the run cadence (throttled). */
  throttled: boolean
  /** Whether a run was actually dispatched to the agent workflow. */
  dispatched: boolean
  /** Run id when a run was started, else null. */
  runId: string | null
  /** Dispatch error message, if any. */
  error: string | null
  /** Display titles of the proposals on the board at decision time. */
  proposals: string[]
}

export interface AgentActivityStore {
  /** Append-only history, oldest first. */
  entries: AgentActivityEntry[]
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the activity log on the durable state volume. Overridable for tests.
 */
let activityPath = '/var/lib/longlive/state/agent-activity.json'

export function setAgentActivityPath(path: string): void {
  activityPath = path
}

export function getAgentActivityPath(): string {
  return activityPath
}

/**
 * How many activity entries to keep. The log is capped (unlike the public
 * ledger, which is append-only forever) to stay small enough to render fast
 * and stay well under the state-carry limit. 500 entries at ~2 runs/day covers
 * roughly a year of evaluations while keeping the file tiny.
 */
export const MAX_ACTIVITY_ENTRIES = 500

// ─── State I/O ────────────────────────────────────────────────────────────

export const EMPTY_ACTIVITY: AgentActivityStore = { entries: [] }

export function parseAgentActivity(data: string): AgentActivityStore {
  if (!data.trim()) return { entries: [] }
  const parsed = JSON.parse(data) as Partial<AgentActivityStore>
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('agent activity has no entries array')
  const entries: AgentActivityEntry[] = []
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Partial<AgentActivityEntry>
    if (
      typeof e.ts !== 'number' ||
      typeof e.mode !== 'string' ||
      typeof e.reason !== 'string'
    ) {
      continue
    }
    entries.push({
      ts: e.ts,
      mode: e.mode as ActivityMode,
      reason: e.reason,
      level: typeof e.level === 'string' ? e.level : '',
      runwayDays: typeof e.runwayDays === 'number' ? e.runwayDays : 0,
      survivalLevel: typeof e.survivalLevel === 'string' ? e.survivalLevel : 'normal',
      throttled: e.throttled === true,
      dispatched: e.dispatched === true,
      runId: typeof e.runId === 'string' ? e.runId : null,
      error: typeof e.error === 'string' ? e.error : null,
      proposals: Array.isArray(e.proposals) ? e.proposals.filter((p): p is string => typeof p === 'string') : [],
    })
  }
  return { entries }
}

export function serializeAgentActivity(state: AgentActivityStore): string {
  return JSON.stringify(state) + '\n'
}

/** Read the activity log from disk. Returns empty on missing file / first boot. */
export async function readAgentActivity(): Promise<AgentActivityStore> {
  try {
    const data = await readFile(activityPath, 'utf8')
    return parseAgentActivity(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [] }
    }
    console.error('agentActivity: failed to read activity log:', err)
    return { entries: [] }
  }
}

async function writeAgentActivity(state: AgentActivityStore): Promise<void> {
  const dir = activityPath.substring(0, activityPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = activityPath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeAgentActivity(state), 'utf8')
  await rename(tmp, activityPath)
}

// ─── Record ───────────────────────────────────────────────────────────────

/**
 * Append an activity entry, pruning to MAX_ACTIVITY_ENTRIES.
 *
 * Call this from the agent trigger after every guarded evaluation so the log
 * stays live from first boot — every decision the agent makes lands here.
 */
export async function recordAgentActivity(entry: AgentActivityEntry): Promise<void> {
  const state = await readAgentActivity()
  const next: AgentActivityStore = {
    entries: [...state.entries, entry],
  }
  while (next.entries.length > MAX_ACTIVITY_ENTRIES) {
    next.entries.shift()
  }
  await writeAgentActivity(next)
}

/** Latest N entries, newest first, with the total count. */
export interface AgentActivityView {
  entries: AgentActivityEntry[]
  total: number
}

export async function agentActivityView(limit = 100): Promise<AgentActivityView> {
  const state = await readAgentActivity()
  return {
    entries: state.entries.slice(-limit).reverse(),
    total: state.entries.length,
  }
}
