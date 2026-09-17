/**
 * Survival Milestones — the app's own "alive so long" record.
 *
 * A milestone is a threshold the app crosses purely by surviving and doing its
 * job: days alive, proposals created, USDC earned, autonomous deployments. This
 * module computes which thresholds are crossed from durable data (the app's age
 * from the state volume, proposals from GitHub Issues, treasury throughput from
 * the ledger) and records them — once, forever — so they can be shown on a
 * public timeline alongside the app's age.
 *
 * The achieved record lives on the durable state volume at
 * STATE_DIR/milestones.json, so a milestone that has been crossed stays crossed
 * across restarts and migrations (the state volume survives; see AGENTS.md).
 * Crossing detection is idempotent and best-effort — call it from a page render
 * or an API route and it only ever turns a "not yet" into "achieved" once.
 *
 * Nothing here needs a key. All inputs are already public: age comes from the
 * durable birthdate + the clock, proposal count from the GitHub issue list the
 * feed already reads, earned USDC and deployment counts from the public ledger.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

/** The categories of survival milestones the app tracks. */
export type MilestoneKind = 'age' | 'proposals' | 'earned' | 'deployments'

export interface MilestoneDef {
  /** Stable id used in the timeline and persisted store. */
  id: string
  kind: MilestoneKind
  /** Threshold for this milestone. */
  target: number
  /** What the target counts — day count, proposal count, USDC, runs. */
  unit: string
  /** Human label, e.g. "7 days alive". */
  label: string
  /** Short description of why this milestone matters. */
  description: string
}

export interface AchievedMilestone {
  def: MilestoneDef
  /** Value at the moment the milestone was crossed. */
  value: number
  /** Unix ms when the milestone was first recorded as achieved. */
  achievedAt: number
}

export interface MilestoneStore {
  /** Unix ms the app "was born" — seeded on first boot, persists via state. */
  bornAt: number
  /** Milestone id → record, only containing achieved milestones. */
  achieved: Record<string, AchievedMilestone>
}

/** Current snapshot of the survival stats the milestones are measured against. */
export interface MilestoneStats {
  /** App age in whole days. */
  ageDays: number
  /** Open proposals on the board. */
  proposalCount: number
  /** Total incoming USDC earned by the treasury. */
  earnedUsdc: number
  /** Count of autonomous agent runs / deployments recorded. */
  deploymentCount: number
}

export interface MilestoneTimeline {
  /** App age in days (used to format the age labels). */
  ageDays: number
  /** All defined milestones, each flagged with whether it is achieved. */
  milestones: {
    def: MilestoneDef
    /** Current value of the stat driving this milestone. */
    value: number
    achieved: boolean
    achievedAt: number | null
  }[]
  /** Overall count of achieved milestones vs total. */
  achievedCount: number
  totalCount: number
  /** The app's birthdate as Unix ms. */
  bornAt: number
}

// ─── Definitions ──────────────────────────────────────────────────────────

/**
 * Every survival milestone the app tracks, in the order they appear on the
 * timeline. Thresholds are the proposal's requested marks. `age` milestones
 * share a "days alive" unit but each is a distinct milestone.
 */
export const MILESTONE_DEFS: MilestoneDef[] = [
  {
    id: 'age-7',
    kind: 'age',
    target: 7,
    unit: 'days',
    label: '7 days alive',
    description: 'Survived the first week — the early bootstrapping stretch.',
  },
  {
    id: 'age-30',
    kind: 'age',
    target: 30,
    unit: 'days',
    label: '30 days alive',
    description: 'A full month of autonomous operation.',
  },
  {
    id: 'proposals-100',
    kind: 'proposals',
    target: 100,
    unit: 'proposals',
    label: '100 proposals',
    description: 'A hundred community ideas reached the board.',
  },
  {
    id: 'earned-100',
    kind: 'earned',
    target: 100,
    unit: 'USDC',
    label: '$100 earned',
    description: 'The treasury received one hundred USDC from supporters.',
  },
  {
    id: 'deployments-50',
    kind: 'deployments',
    target: 50,
    unit: 'deployments',
    label: '50 autonomous deployments',
    description: 'Fifty autonomous agent runs deployed changes to the live site.',
  },
]

/** Milestone def by id; undefined when the id is unknown. */
export function milestoneById(id: string): MilestoneDef | undefined {
  return MILESTONE_DEFS.find((d) => d.id === id)
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the milestone store on the durable state volume. Overridable for
 * tests.
 */
let storePath = '/var/lib/longlive/state/milestones.json'

export function setMilestonesPath(path: string): void {
  storePath = path
}

export function getMilestonesPath(): string {
  return storePath
}

// ─── State I/O ────────────────────────────────────────────────────────────

/** A milestone store that has never seen a crossing (and no birthdate yet). */
export function emptyMilestoneStore(): MilestoneStore {
  return { bornAt: 0, achieved: {} }
}

export function parseMilestoneStore(data: string): MilestoneStore {
  if (!data.trim()) return emptyMilestoneStore()
  const parsed = JSON.parse(data) as Partial<MilestoneStore>
  const achieved: Record<string, AchievedMilestone> = {}
  if (parsed.achieved && typeof parsed.achieved === 'object') {
    for (const [id, rec] of Object.entries(parsed.achieved)) {
      if (!rec || typeof rec !== 'object') continue
      const r = rec as Partial<AchievedMilestone>
      const def = milestoneById(id)
      if (
        def &&
        typeof r.value === 'number' &&
        typeof r.achievedAt === 'number'
      ) {
        achieved[id] = { def, value: r.value, achievedAt: r.achievedAt }
      }
    }
  }
  return {
    bornAt: typeof parsed.bornAt === 'number' && parsed.bornAt > 0 ? parsed.bornAt : 0,
    achieved,
  }
}

export function serializeMilestoneStore(store: MilestoneStore): string {
  return JSON.stringify(store) + '\n'
}

async function readMilestoneStore(): Promise<MilestoneStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseMilestoneStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyMilestoneStore()
    }
    console.error('milestones: failed to read store:', err)
    return emptyMilestoneStore()
  }
}

async function writeMilestoneStore(store: MilestoneStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeMilestoneStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Birthdate ────────────────────────────────────────────────────────────

/**
 * Ensure the store has a birthdate. On first boot there is none; we derive one
 * from the oldest ledger entry if present, else from right now, and persist it.
 * The birthdate only ever moves backward (an earlier birth takes precedence),
 * so a restart or a late migration cannot move the app's age forward
 * artificially. Returns the settled birthdate in unix ms.
 */
export async function settleBirthdate(anchorTs: number | null = null): Promise<number> {
  const store = await readMilestoneStore()
  // If we already know the birthdate, keep it (monotonic — never younger).
  if (store.bornAt > 0) return store.bornAt
  const born = anchorTs && anchorTs > 0 && anchorTs < Date.now() ? anchorTs : Date.now()
  await writeMilestoneStore({ ...store, bornAt: born })
  return born
}

// ─── Stats computation ────────────────────────────────────────────────────

/**
 * Whole days elapsed since the birthdate (min 0). A day is counted once a full
 * 24h has passed, so "7 days alive" unlocks on the 8th day of existence — the
 * threshold means "was alive for 7 full days".
 */
export function ageDaysFrom(bornAt: number, now: number = Date.now()): number {
  if (bornAt <= 0) return 0
  return Math.max(0, Math.floor((now - bornAt) / (24 * 60 * 60 * 1000)))
}

/**
 * Compute the current stat value driving each milestone from the given store
 * (for its birthdate) and the live stats.
 */
export function computeTimeline(
  store: MilestoneStore,
  stats: MilestoneStats,
): MilestoneTimeline {
  const milestones = MILESTONE_DEFS.map((def) => {
    const value = statForKind(def.kind, store, stats)
    const rec = store.achieved[def.id]
    return {
      def,
      value,
      achieved: Boolean(rec),
      achievedAt: rec ? rec.achievedAt : null,
    }
  })
  const achievedCount = milestones.filter((m) => m.achieved).length
  return {
    ageDays: stats.ageDays,
    milestones,
    achievedCount,
    totalCount: milestones.length,
    bornAt: store.bornAt,
  }
}

/** The current numeric value of a milestone kind. */
function statForKind(
  kind: MilestoneKind,
  store: MilestoneStore,
  stats: MilestoneStats,
): number {
  switch (kind) {
    case 'age':
      return stats.ageDays
    case 'proposals':
      return stats.proposalCount
    case 'earned':
      return stats.earnedUsdc
    case 'deployments':
      return stats.deploymentCount
    default:
      return 0
  }
}

/**
 * Evaluate the current stats against every defined milestone and record any
 * newly-crossed ones (idempotent — already-achieved milestones are untouched).
 * Returns the store with any new achievements persisted.
 */
export async function evaluateMilestones(
  stats: MilestoneStats,
): Promise<MilestoneStore> {
  const store = await readMilestoneStore()
  const now = Date.now()
  let changed = false
  const next: MilestoneStore = {
    ...store,
    achieved: { ...store.achieved },
  }
  for (const def of MILESTONE_DEFS) {
    if (next.achieved[def.id]) continue
    const value = statForKind(def.kind, next, stats)
    if (value >= def.target) {
      next.achieved[def.id] = { def, value, achievedAt: now }
      changed = true
    }
  }
  if (changed) await writeMilestoneStore(next)
  return next
}

// ─── Public read helpers ──────────────────────────────────────────────────

/**
 * Evaluate against the given stats, ensure a birthdate, and return the current
 * timeline for display. Idempotent and side-effecting only when a milestone
 * was first crossed or the birthdate first settled — safe to call on any page
 * render.
 */
export async function getMilestoneTimeline(
  stats: MilestoneStats,
  anchorTs: number | null = null,
): Promise<MilestoneTimeline> {
  const born = await settleBirthdate(anchorTs)
  const withBorn = {
    ...stats,
    ageDays: ageDaysFrom(born),
  }
  const store = await evaluateMilestones(withBorn)
  return computeTimeline(store, withBorn)
}

/**
 * Pure version of the timeline for a known store — no I/O, used by tests and
 * by callers that already hold a store. Does not record new achievements.
 */
export function timelineFromStore(store: MilestoneStore, stats: MilestoneStats): MilestoneTimeline {
  return computeTimeline(store, stats)
}
