/**
 * Runway governor: burn ledger + runway calculation.
 *
 * A small JSON ledger records inference spend and hosting cost per agent run,
 * persisted on the durable state volume. The runway computation uses the
 * trailing 7-day daily burn to estimate how many days the treasury can last.
 *
 * The ledger lives at STATE_DIR/runway-ledger.json and is a simple JSON array
 * of run entries. It is pruned to keep at most 90 entries (roughly 90 runs,
 * well over a week's worth at 2 runs/day).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────

export interface RunEntry {
  /** Unix timestamp (ms) when the run completed. */
  ts: number
  /** Cost of this inference run in USDC (float). */
  inferenceCostUsdc: number
  /** Hosting cost allocated to this run in USDC (float). */
  hostingCostUsdc: number
  /** Total cost of this run in USDC. */
  totalCostUsdc: number
}

export interface RunwayInfo {
  /** Current treasury balance in USDC. */
  treasuryBalance: number
  /** Trailing 7-day daily average burn in USDC/day. */
  dailyBurn: number
  /** Estimated runway in days (treasury / daily burn). Infinity if no burn. */
  runwayDays: number
  /** Number of recorded runs in the trailing window. */
  runsInWindow: number
  /** Total recorded burn in the trailing window. */
  totalBurnInWindow: number
  /** Remediation level. */
  level: 'safe' | 'reduced' | 'critical' | 'paused'
  /** Policy suggestion. */
  policy: string
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Hosting cost per day in USDC. This is an estimate based on the VPS cost.
 * The smallest Hetzner CAX11 is ~€3.99/month ≈ $0.14/day. We round up to $0.20
 * for a conservative estimate.
 */
export const HOSTING_COST_PER_DAY = 0.20

/**
 * Path to the ledger file. In production this is on the state volume;
 * overridable for testing.
 */
let ledgerPath = '/var/lib/longlive/state/runway-ledger.json'

export function setLedgerPath(path: string): void {
  ledgerPath = path
}

export function getLedgerPath(): string {
  return ledgerPath
}

// ─── Ledger I/O ───────────────────────────────────────────────────────────

const MAX_ENTRIES = 90

export function parseLedger(data: string): RunEntry[] {
  if (!data.trim()) return []
  const parsed = JSON.parse(data)
  if (!Array.isArray(parsed)) throw new Error('ledger is not an array')
  // Validate shape
  for (const entry of parsed) {
    if (typeof entry.ts !== 'number' || typeof entry.inferenceCostUsdc !== 'number' ||
        typeof entry.hostingCostUsdc !== 'number' || typeof entry.totalCostUsdc !== 'number') {
      throw new Error('invalid ledger entry shape')
    }
  }
  return parsed as RunEntry[]
}

export function serializeLedger(entries: RunEntry[]): string {
  return JSON.stringify(entries) + '\n'
}

/**
 * Read the ledger from disk. Returns [] on missing file or parse error.
 */
export async function readLedger(): Promise<RunEntry[]> {
  try {
    const data = await readFile(ledgerPath, 'utf8')
    return parseLedger(data)
  } catch (err: unknown) {
    // ENOENT is fine — first boot
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    // Other errors: log and return empty rather than crashing the page
    console.error('runway: failed to read ledger:', err)
    return []
  }
}

/**
 * Write ledger to disk. Ensures the directory exists.
 */
export async function writeLedger(entries: RunEntry[]): Promise<void> {
  const dir = ledgerPath.substring(0, ledgerPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  // Write atomically: temp file + rename
  const tmp = ledgerPath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeLedger(entries), 'utf8')
  await rename(tmp, ledgerPath)
}

/**
 * Append a run entry to the ledger and prune to MAX_ENTRIES.
 */
export async function recordRun(
  inferenceCostUsdc: number,
  hostingCostUsdc: number,
): Promise<void> {
  const entries = await readLedger()
  const totalCostUsdc = inferenceCostUsdc + hostingCostUsdc
  entries.push({
    ts: Date.now(),
    inferenceCostUsdc,
    hostingCostUsdc,
    totalCostUsdc,
  })
  // Prune oldest entries beyond MAX_ENTRIES
  while (entries.length > MAX_ENTRIES) {
    entries.shift()
  }
  await writeLedger(entries)
}

// ─── Runway Computation ───────────────────────────────────────────────────

/**
 * Compute runway from treasury balance, the ledger entries, and hosting cost.
 *
 * Hosting is a standing daily burn — the box serving the site costs money
 * every day whether or not any agent run happened — so it is added as a floor
 * to the daily burn derived from the ledger's recorded inference runs. That
 * keeps the runway live from first boot (nonzero burn even before the first
 * run is logged) instead of reporting Infinity until something was spent.
 *
 * `inferredDailyBurn` can be passed in to drop or scale the ledger-derived
 * portion for tests.
 */
export function computeRunway(
  treasuryBalance: number,
  entries: RunEntry[],
  { hostingCostPerDay = HOSTING_COST_PER_DAY } = {},
): RunwayInfo {
  const now = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const cutoff = now - sevenDaysMs

  const windowEntries = entries.filter((e) => e.ts >= cutoff)
  const totalInferenceInWindow = windowEntries.reduce(
    (sum, e) => sum + e.inferenceCostUsdc,
    0
  )
  // Hosting floor + the 7-day average of recorded inference spend.
  const dailyBurn = hostingCostPerDay + totalInferenceInWindow / 7
  const runwayDays = dailyBurn > 0 ? treasuryBalance / dailyBurn : Infinity

  let level: RunwayInfo['level']
  let policy: string

  if (runwayDays >= 30) {
    level = 'safe'
    policy = 'current cadence (2 runs/day), current model'
  } else if (runwayDays >= 10) {
    level = 'reduced'
    policy = '1 run/day'
  } else if (runwayDays >= 3) {
    level = 'critical'
    policy = '1 run every 3 days, cheapest capable model, hard token cap per run'
  } else {
    level = 'paused'
    policy = 'no implementation runs — serve site only'
  }

  return {
    treasuryBalance,
    dailyBurn: Math.round(dailyBurn * 100) / 100,
    runwayDays: runwayDays === Infinity ? Infinity : Math.round(runwayDays * 10) / 10,
    runsInWindow: windowEntries.length,
    totalBurnInWindow: Math.round(totalInferenceInWindow * 100) / 100,
    level,
    policy,
  }
}

/**
 * Get the current runway info. Reads the treasury and ledger.
 */
export async function getRunway(
  getBalance: () => Promise<number>,
): Promise<RunwayInfo> {
  const [balance, entries] = await Promise.all([
    getBalance().catch(() => 0),
    readLedger(),
  ])
  return computeRunway(balance, entries)
}

/**
 * Record an agent run's inference spend into the ledger, attributing a share
 * of the standing hosting cost to it. Callers (a route, or future agent-side
 * code that knows a run's cost) pass the inference cost; the total stored is
 * inference + a per-run hosting slice.
 */
export async function recordInferenceRun(inferenceCostUsdc: number): Promise<void> {
  // Attribute one day-proportional hosting slice per run. It is stored so the
  // ledger is a faithful record of what a run really cost. Daily burn still
  // counts the full hosting floor separately via computeRunway; the slice is
  // for the ledger's own per-run record.
  const hostingSlice = HOSTING_COST_PER_DAY
  await recordRun(inferenceCostUsdc, hostingSlice)
}
