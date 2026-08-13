// Public log of past agent implement runs.
//
// The agent loop (`.github/workflows/agent.yml`) streams the implement step's
// whole activity to the workflow log as JSONL (one JSON object per line:
// step_start, tool_use, text, step_finish, plus error). That log IS the record
// of the run — this module republishes it on the site: list the workflow's
// runs over the Actions API, download each log, and render the event stream as
// a chat transcript. No database, no extra ref, no new credentials: the same
// app-token/PAT path as proposals (config.ts → github.ts) works because the
// app's credentials include actions:write.
//
// Only runs that actually implemented something appear: scheduled sweeps that
// found no eligible proposal emit no implement stream, so they have no
// transcript to show. Manual dispatches are excluded the same way sweeps are —
// they exercise the pipeline, not a proposal.
//
// Logs expire with GitHub's retention window (~90 days); the list read goes
// through the same coalesce + TTL + stale-on-error cache as the proposal list
// so a transient GitHub blip never blanks the page.

import { gh } from './github.ts'
import { github } from './config.ts'
import { defineCache } from './cache.ts'

export const RUNS_WORKFLOW = 'agent.yml'
/** How many implement runs the page shows, newest first. */
const RUNS_LIMIT = 10
/** Cap on one downloaded log — a runaway stream must not OOM the server. */
const LOG_CAP = 900_000

/** A single event line from the implement stream. The shape is intentionally
 * tolerant: only fields the transcript renders are typed, everything else is
 * carried through as-is. */
export interface RunEvent {
  type: 'step_start' | 'tool_use' | 'text' | 'step_finish' | 'error' | (string & {})
  /** step_start / step_finish */
  step?: string
  /** text */
  text?: string
  /** tool_use */
  tool?: string
  input?: unknown
  title?: string
  state?: string
  resultSummary?: string
  /** error */
  error?: string
  /** any remaining fields (timestamps, ids, …) */
  [k: string]: unknown
}

export interface Run {
  /** Actions run id, as a string. */
  id: string
  /** Proposal the run implemented. */
  proposal: string
  /** Inference model that ran the step, '' when unknown. */
  model: string
  /** Workflow conclusion (success / failure / …), '' when unknown. */
  outcome: string
  /** Spend as a quoted string (kept opaque — never a live total). */
  cost: string
  /** ISO timestamp the run started, '' when unknown. */
  startedAt: string
  /** The parsed event stream, in document order. */
  events: RunEvent[]
}

/** The subset of the Actions workflow-run object this module reads. */
interface WorkflowRun {
  id: number
  name?: string | null
  display_title?: string | null
  event?: string | null
  conclusion?: string | null
  created_at?: string | null
  head_branch?: string | null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** First non-empty string field across events of `type`. */
function pick(events: RunEvent[], type: RunEvent['type'], field: string): string {
  for (const e of events) {
    if (e.type !== type) continue
    const v = e[field]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * One downloaded workflow log → the implement event stream. Pure — unit-tested
 * without network.
 *
 * The log interleaves opencode's JSONL events with plain shell output from the
 * other steps (and on some runners a timestamp prefix on every line), so a
 * line counts only when it parses to an object with a string `type`. When the
 * payload is nested under `part` (newer event shapes), its fields are lifted
 * so the renderer sees one flat event either way.
 */
export function parseLog(log: string): RunEvent[] {
  const events: RunEvent[] = []
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue // shell output, timestamps, banners — not events
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    const rec = obj as Record<string, unknown>
    if (typeof rec.type !== 'string') continue
    const part = rec.part
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      for (const [k, v] of Object.entries(part as Record<string, unknown>)) {
        if (!(k in rec)) rec[k] = v
      }
    }
    events.push(rec as unknown as RunEvent)
  }
  return events
}

/** Workflow-run fields + event stream → a Run. Pure. */
export function summarize(wr: WorkflowRun, events: RunEvent[]): Run {
  const branch = str(wr.head_branch).replace(/^feat\//, '').replace(/-/g, ' ').trim()
  const proposal =
    pick(events, 'step_start', 'proposal') ||
    branch ||
    str(wr.display_title).trim() ||
    `Run #${wr.id}`
  return {
    id: String(wr.id),
    proposal,
    model: pick(events, 'step_start', 'model') || pick(events, 'step_start', 'modelID'),
    outcome: str(wr.conclusion),
    cost: pick(events, 'step_finish', 'cost'),
    startedAt: str(wr.created_at),
    events,
  }
}

async function fetchLog(runId: number): Promise<string> {
  // GitHub 302-redirects to the archive; undici follows it. A 410 means the
  // retention window expired — there is no transcript left to show.
  const res = await gh(`/repos/${github.repo}/actions/runs/${runId}/logs`, {
    headers: { 'User-Agent': 'longlivethis-runs' },
  })
  if (res.status === 404 || res.status === 410) return ''
  if (!res.ok) throw new Error(`log for run ${runId} failed: ${res.status}`)
  return (await res.text()).slice(0, LOG_CAP)
}

async function loadRuns(): Promise<Run[]> {
  const res = await gh(
    `/repos/${github.repo}/actions/workflows/${RUNS_WORKFLOW}/runs?per_page=30`,
    { headers: { 'User-Agent': 'longlivethis-runs' } }
  )
  if (!res.ok) throw new Error(`GitHub list workflow runs failed: ${res.status}`)
  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] }

  // Runs that could hold an implement transcript: the agent workflow ran to
  // completion on a proposal branch. Sweeps that found nothing to build, and
  // manual dispatches, are dropped below when their log yields no events.
  const candidates = (body.workflow_runs ?? [])
    .filter((r) => r.name === 'agent' && r.event !== 'workflow_dispatch')
    .filter((r) => str(r.head_branch).startsWith('feat/'))
    .sort((a, b) => +new Date(str(b.created_at)) - +new Date(str(a.created_at)))
    .slice(0, RUNS_LIMIT)

  const runs = await Promise.all(
    candidates.map(async (wr) => {
      try {
        const events = parseLog(await fetchLog(wr.id))
        return events.length > 0 ? summarize(wr, events) : null
      } catch {
        return null // one unreadable log must not blank the whole page
      }
    })
  )
  return runs.filter((r): r is Run => r !== null)
}

// Read on every page view, so coalesce + TTL + stale-on-error like the proposal
// list: a burst of views costs one list read, and a GitHub bounce doesn't blank
// the log.
const runsCache = defineCache('runs-log', 60_000, loadRuns, { serveStaleOnError: true })

export function listRuns(): Promise<Run[]> {
  return runsCache.get()
}
