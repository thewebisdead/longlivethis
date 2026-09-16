// Public ledger — the transparency record the /ledger page renders.
//
// Append-only log of every agent run cost and every incoming USDC transfer
// to the treasury, persisted on the durable state volume at
// STATE_DIR/ledger.json. It is intentionally separate from the runway ledger
// (runway.ts): that one is pruned to the trailing window for burn math, while
// this one is the full, auditable history shown to the public.
//
// Nothing here needs a key. Run costs come from the agent loop via
// runway.ts's recordInferenceRun (wired below). Incoming transfers are
// detected without any RPC event subscription: the treasury balance is already
// read server-side every minute (cached in treasury.ts), and recordBalance()
// compares each fresh read against the last observed balance, appending a
// transfer entry for any increase. That keeps the ledger live from first boot
// with no external service — transparency is a natural byproduct of the app's
// existing balance read.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export type LedgerEntry =
  | {
      type: 'run'
      /** Unix timestamp (ms) when the run was recorded. */
      ts: number
      /** Short identifier for this agent run (e.g. a git sha or run id). */
      runId: string
      /** Inference spend for the run, USDC (float). */
      inferenceCostUsdc: number
      /** Hosting cost attributed to the run, USDC (float). */
      hostingCostUsdc: number
      /** inference + hosting, USDC (float). */
      totalCostUsdc: number
    }
  | {
      type: 'transfer'
      /** Unix timestamp (ms) when the transfer was detected. */
      ts: number
      /** Incoming amount, USDC (float). */
      amountUsdc: number
      /** Treasury balance immediately after the transfer, USDC. */
      balanceAfterUsdc: number
    }

export interface LedgerState {
  /** Append-only history, oldest first. */
  entries: LedgerEntry[]
  /**
   * Last treasury balance observed, in USDC. Drives transfer detection:
   * a fresh balance read above this appends a transfer entry. null before the
   * first observation (baseline is set, nothing recorded).
   */
  lastBalanceUsdc: number | null
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the ledger file. In production this is on the state volume;
 * overridable for testing.
 */
let ledgerPath = '/var/lib/longlive/state/ledger.json'

export function setLedgerPath(path: string): void {
  ledgerPath = path
}

export function getLedgerPath(): string {
  return ledgerPath
}

// ─── Ledger I/O ───────────────────────────────────────────────────────────

export const EMPTY_STATE: LedgerState = { entries: [], lastBalanceUsdc: null }

export function parseLedger(data: string): LedgerState {
  if (!data.trim()) return { entries: [], lastBalanceUsdc: null }
  const parsed = JSON.parse(data) as LedgerState
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('ledger has no entries array')
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('invalid ledger entry')
    if (entry.type === 'run') {
      if (
        typeof entry.ts !== 'number' ||
        typeof entry.runId !== 'string' ||
        typeof entry.inferenceCostUsdc !== 'number' ||
        typeof entry.hostingCostUsdc !== 'number' ||
        typeof entry.totalCostUsdc !== 'number'
      ) {
        throw new Error('invalid run ledger entry')
      }
    } else if (entry.type === 'transfer') {
      if (
        typeof entry.ts !== 'number' ||
        typeof entry.amountUsdc !== 'number' ||
        typeof entry.balanceAfterUsdc !== 'number'
      ) {
        throw new Error('invalid transfer ledger entry')
      }
    } else {
      throw new Error('unknown ledger entry type')
    }
  }
  const last = parsed.lastBalanceUsdc
  return {
    entries: parsed.entries as LedgerEntry[],
    lastBalanceUsdc: last === null || last === undefined ? null : Number(last),
  }
}

export function serializeLedger(state: LedgerState): string {
  return JSON.stringify(state) + '\n'
}

/**
 * Read the ledger from disk. Returns EMPTY_STATE on missing file or first boot.
 * On a parse error (corrupt file from a mid-write copy), log and return empty
 * rather than crashing the page — the ledger is display data, not life support.
 */
export async function readLedger(): Promise<LedgerState> {
  try {
    const data = await readFile(ledgerPath, 'utf8')
    return parseLedger(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], lastBalanceUsdc: null }
    }
    console.error('ledger: failed to read ledger:', err)
    return { entries: [], lastBalanceUsdc: null }
  }
}

/**
 * Write ledger to disk. Ensures the directory exists and writes atomically
 * (temp file + rename) so a concurrent copy never catches a half-written file.
 */
export async function writeLedger(state: LedgerState): Promise<void> {
  const dir = ledgerPath.substring(0, ledgerPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = ledgerPath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeLedger(state), 'utf8')
  await rename(tmp, ledgerPath)
}

/** Round to 6 decimals (USDC's resolution) to keep figures tidy. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Append an entry to the ledger (in memory) and persist. */
async function appendAndPersist(entry: LedgerEntry, mutate: (s: LedgerState) => void): Promise<void> {
  const state = await readLedger()
  const next: LedgerState = {
    entries: [...state.entries, entry],
    lastBalanceUsdc: state.lastBalanceUsdc,
  }
  mutate(next)
  await writeLedger(next)
}

/**
 * Generate a short run identifier. Falls back to a timestamp if no run id is
 * supplied — the caller (the agent loop) normally traces its own run.
 */
function defaultRunId(): string {
  return `run-${Date.now()}`
}

/**
 * Record an agent run's cost into the public ledger. Pure append — unlike the
 * runway ledger it is never pruned, so the full history stays auditable.
 *
 * Wired from runway.ts's recordInferenceRun so the two ledger writes share one
 * call site and the run-cost path is live from the moment a run is recorded.
 */
export async function recordRunCost(
  inferenceCostUsdc: number,
  hostingCostUsdc: number,
  runId: string = defaultRunId(),
): Promise<void> {
  await appendAndPersist(
    {
      type: 'run',
      ts: Date.now(),
      runId,
      inferenceCostUsdc: round6(inferenceCostUsdc),
      hostingCostUsdc: round6(hostingCostUsdc),
      totalCostUsdc: round6(inferenceCostUsdc + hostingCostUsdc),
    },
    () => void 0,
  )
}

/**
 * Observe the current treasury balance, appending a transfer entry for any
 * increase over the last observed balance and updating the baseline.
 *
 * Safe to call on every fresh balance read: flat or falling balances just
 * update the baseline and record nothing, so this is idempotent and cheap.
 * Returns the newly recorded transfer amount, or null if there was nothing to
 * record (or it was the first observation, i.e. baseline setup).
 */
export async function recordBalance(balanceUsdc: number): Promise<number | null> {
  const state = await readLedger()
  const last = state.lastBalanceUsdc
  let recorded: number | null = null

  if (last !== null && balanceUsdc > last + 1e-6) {
    recorded = round6(balanceUsdc - last)
    state.entries.push({
      type: 'transfer',
      ts: Date.now(),
      amountUsdc: recorded,
      balanceAfterUsdc: round6(balanceUsdc),
    })
  }

  state.lastBalanceUsdc = round6(balanceUsdc)
  await writeLedger(state)
  return recorded
}

/**
 * Full ledger with derived totals, as the /ledger page wants to render and the
 * /api/ledger route wants to serve.
 */
export interface LedgerView {
  state: LedgerState
  totalRunCostUsdc: number
  totalTransferredUsdc: number
  balanceUsdc: number
}

export function summarize(state: LedgerState): LedgerView {
  let totalRunCostUsdc = 0
  let totalTransferredUsdc = 0
  for (const entry of state.entries) {
    if (entry.type === 'run') totalRunCostUsdc += entry.totalCostUsdc
    else totalTransferredUsdc += entry.amountUsdc
  }
  return {
    state,
    totalRunCostUsdc: round6(totalRunCostUsdc),
    totalTransferredUsdc: round6(totalTransferredUsdc),
    balanceUsdc: round6(state.lastBalanceUsdc ?? 0),
  }
}
