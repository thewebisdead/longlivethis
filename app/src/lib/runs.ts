// Public log of past agent implement runs.
//
// Implement.sh streams its whole activity to the workflow log as JSONL (one
// JSON object per line: step_start, tool_use, text, step_finish, plus error).
// That log expires with GitHub's retention window, so this module republishes
// the same event stream to the site — no database, no new credentials.
//
// Convention (git-as-store, like proposals/votes):
//   Ref:   runs-log (an orphan branch, so transcripts never bloat main)
//   Files: runs/<runId>.jsonl — one JSONL event stream per run
//
// The first line of each file is a lone run-metadata object (`{"_run":{…}}`),
// so the page can list runs (date, proposal, model, outcome, cost) from one
// read; the remaining lines are the opencode event stream rendered as a chat
// transcript. Files produced without that metadata line degrade gracefully to
// fields derived from the event stream.
//
// The ref does not exist until a run is first delivered; until then the page
// renders an empty state. Reads go through the same app-token/PAT path as
// proposals (config.ts → github.ts) and serve stale-on-error with a TTL so a
// transient GitHub blip never blanks the log.

import { gh } from './github.ts'
import { github } from './config.ts'
import { defineCache } from './cache.ts'

export const RUNS_REF = 'runs-log'
const RUNS_PREFIX = 'runs/'

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

/** Head-of-file metadata object carrying the run's list fields. */
export interface RunMeta {
  id?: unknown
  issue?: unknown
  proposal?: unknown
  model?: unknown
  outcome?: unknown
  cost?: unknown
  startedAt?: unknown
}

export interface Run {
  /** Ref-relative file id (file basename without .jsonl). */
  id: string
  /** Proposal the run implemented. */
  proposal: string
  /** Inference model that ran the step, '' when unknown. */
  model: string
  /** Outcome summary, '' when unknown. */
  outcome: string
  /** Spend as a quoted string (kept opaque — never a live total). */
  cost: string
  /** ISO timestamp the run started, '' when unknown. */
  startedAt: string
  /** The parsed event stream, in document order. */
  events: RunEvent[]
  /** Path of the file on the runs-log ref (for a "source" link). */
  path: string
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

/** One JSONL file → a Run. Pure — unit-tested without network. */
export function parseRunFile(path: string, raw: string): Run {
  const events: RunEvent[] = []
  let meta: RunMeta = {}

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue // ignore unparseable lines
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    const rec = obj as Record<string, unknown>
    // Metadata line: a lone object whose only meaningful key is `_run`.
    if (rec && typeof rec._run === 'object' && rec._run !== null) {
      meta = rec._run as RunMeta
      continue
    }
    events.push(rec as unknown as RunEvent)
  }

  const id = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? path
  const proposal =
    str(meta.proposal) ||
    pick(events, 'step_start', 'proposal') ||
    pick(events, 'text', 'proposal') ||
    path
  const model = str(meta.model) || pick(events, 'step_start', 'model')
  const outcome = str(meta.outcome) || pick(events, 'step_finish', 'outcome') || pick(events, 'error', 'error')
  const cost = str(meta.cost) || pick(events, 'step_finish', 'cost')
  const startedAt = str(meta.startedAt) || pick(events, 'step_start', 'timestamp')

  return { id, proposal, model, outcome, cost, startedAt, events, path }
}

async function loadRuns(): Promise<Run[]> {
  const res = await gh(`/repos/${github.repo}/git/trees/${RUNS_REF}?recursive=1`)
  if (!res.ok) return [] // ref absent (no runs yet) or unreachable → empty log

  const tree = (await res.json()) as { tree?: { path?: string; type?: string }[] }
  if (!Array.isArray(tree.tree)) return []

  const paths = tree.tree
    .filter((t) => t.type === 'blob' && t.path?.startsWith(RUNS_PREFIX) && t.path.endsWith('.jsonl'))
    .map((t) => t.path as string)

  const parsed = await Promise.all(
    paths.map(async (path) => {
      try {
        return parseRunFile(path, await readRunFile(path))
      } catch {
        return null // a bad file must not blank the whole log
      }
    })
  )

  return parsed
    .filter((r): r is Run => r !== null)
    .sort((a, b) => {
      const ta = a.startedAt ? +new Date(a.startedAt) : NaN
      const tb = b.startedAt ? +new Date(b.startedAt) : NaN
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta
      return a.id < b.id ? 1 : -1
    })
}

async function readRunFile(path: string): Promise<string> {
  // The contents API returns base64 for non-text extensions like .jsonl.
  const res = await gh(`/repos/${github.repo}/contents/${encodeURIComponent(path)}?ref=${RUNS_REF}`)
  if (!res.ok) throw new Error(`read ${path} failed: ${res.status}`)
  const body = (await res.json()) as { content?: string; encoding?: string }
  if (typeof body.content !== 'string') throw new Error(`read ${path}: no content`)
  return Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
}

// Read on every page view, so coalesce + TTL + stale-on-error like the proposal
// list: a burst of views costs one request, and a GitHub bounce doesn't blank
// the log.
const runsCache = defineCache('runs-log', 60_000, loadRuns, { serveStaleOnError: true })

export function listRuns(): Promise<Run[]> {
  return runsCache.get()
}
