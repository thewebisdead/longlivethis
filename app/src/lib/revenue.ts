/**
 * Revenue propositions — first-class, categorized ways to fund the treasury.
 *
 * The app's whole objective is survival, so sending it money should be as
 * structured as proposing features is: not just a bare donate button, but a
 * concrete menu of what a supporter can fund and what they get back. Each
 * revenue proposition is a small work item — "sponsor this slot", "buy an API
 * key", "claim the supporter badge" — with a target amount and a status. A
 * visitor funds one by sending USDC to the treasury (the same wallet the
 * donate button uses); the app tracks which opportunities are open, claimed
 * and funded.
 *
 * Unlike feature proposals (GitHub Issues), revenue propositions are native to
 * the app: they live on the durable state volume so they survive restarts and
 * migrations, and they are seeded on first boot with a curated set so the
 * board is live from day one rather than waiting for someone to fill it.
 *
 * Statuses:
 *   open     — available to fund / build.
 *   claimed  — a supporter committed to it (e.g. picked a sponsorship slot);
 *              still funded via the treasury until the money arrives.
 *   funded   — the target has been reached; the work is owed / done.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export type RevenueType =
  | 'sponsorship' // a named slot on the homepage / README
  | 'api' // tiered access to an API the app exposes
  | 'badge' // a supporter badge / acknowledgement
  | 'widget' // an embeddable hosted widget
  | 'milestone' // a donative milestone unlock
  | 'marketplace' // a listing / integration on a marketplace
  | 'other'

export type RevenueStatus = 'open' | 'claimed' | 'funded'

export interface RevenueProposal {
  /** Stable, unique id (a monotonic counter within the store). */
  id: number
  /** Categorical kind — what kind of revenue mechanism this is. */
  type: RevenueType
  /** Short, scannable title. */
  title: string
  /** What the supporter funds and what they get back. */
  description: string
  /** Funding goal in USDC. */
  targetUsdc: number
  /** funding/revenue floor below which this is not worth pursuing (USDC). */
  minUsdc: number
  status: RevenueStatus
  /** Unix ms it was added. */
  createdAt: number
  /** Unix ms it last changed status. */
  updatedAt: number
}

export interface RevenueStore {
  /** Oldest first; the homepage renders most-recent first. */
  proposals: RevenueProposal[]
  /** Next id to hand out (monotonic). */
  nextId: number
}

// ─── Seed set ─────────────────────────────────────────────────────────────

/**
 * The revenue propositions the board opens with, so the funding menu is live
 * from the very first boot. This is a source constant, not persisted config:
 * it is the app's honest case for funding itself. These targets are small
 * enough to be reachable by a supporter and large enough to matter to the
 * runway.
 */
export const SEED_REVENUE_PROPOSALS: Omit<RevenueProposal, 'id' | 'createdAt' | 'updatedAt' | 'status'>[] = [
  {
    type: 'sponsorship',
    title: 'Sponsor the homepage slot',
    description:
      'Reserve a named slot on the homepage’s “supported by” strip and README — your handle, site or project next to the treasury, for a funding cycle.',
    targetUsdc: 50,
    minUsdc: 10,
  },
  {
    type: 'badge',
    title: 'Supporter badge',
    description:
      'Claim a permanent “early supporter” badge and a line in the /ledger acknowledgements. Small, personal, forever.',
    targetUsdc: 20,
    minUsdc: 5,
  },
  {
    type: 'api',
    title: 'Paid read API',
    description:
      'Stand up a keyed API for the treasury balance, runway and ledger — this homepage data made machine-readable, with a usage tier paid in USDC.',
    targetUsdc: 120,
    minUsdc: 20,
  },
  {
    type: 'milestone',
    title: 'Survival milestone — 90 days of runway',
    description:
      'Fund a runway milestone: the first time the treasury projects 90+ days of runway is marked on the homepage and ledger.',
    targetUsdc: 150,
    minUsdc: 25,
  },
  {
    type: 'widget',
    title: 'Hosted treasury widget',
    description:
      'An embeddable widget anyone can drop on their own site to show this treasury’s live balance — we host it, they link back.',
    targetUsdc: 80,
    minUsdc: 15,
  },
  {
    type: 'marketplace',
    title: 'Marketplace listing',
    description:
      'Get this app listed on an independent-app / self-hosting marketplace so new supporters can find it; half funds the listing fee.',
    targetUsdc: 100,
    minUsdc: 25,
  },
]

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the revenue store on the durable state volume. Overridable for
 * tests.
 */
let storePath = '/var/lib/longlive/state/revenue-proposals.json'

export function setRevenueStorePath(path: string): void {
  storePath = path
}

export function getRevenueStorePath(): string {
  return storePath
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export interface RevenueProposalInput {
  type: RevenueType
  title: string
  description: string
  targetUsdc: number
  minUsdc?: number
}

/** Validate + normalize a new revenue proposition. Pure. */
export function validateRevenueProposal(
  input: RevenueProposalInput,
): Omit<RevenueProposal, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const type = input.type
  if (!['sponsorship', 'api', 'badge', 'widget', 'milestone', 'marketplace', 'other'].includes(type)) {
    throw new Error(`unknown revenue type: ${String(type)}`)
  }
  const title = input.title.trim()
  if (!title) throw new Error('title required')
  if (title.length > 120) throw new Error('title too long')
  const description = input.description.trim()
  if (!description) throw new Error('description required')
  const targetUsdc = input.targetUsdc
  if (!Number.isFinite(targetUsdc) || targetUsdc <= 0) throw new Error('targetUsdc must be positive')
  const minUsdc = input.minUsdc ?? Math.min(1, targetUsdc)
  if (!Number.isFinite(minUsdc) || minUsdc <= 0) throw new Error('minUsdc must be positive')
  if (minUsdc > targetUsdc) throw new Error('minUsdc cannot exceed targetUsdc')
  return { type, title, description, targetUsdc, minUsdc }
}

export function parseRevenueStore(data: string): RevenueStore {
  if (!data.trim()) return emptyStore()
  const parsed = JSON.parse(data) as Partial<RevenueStore>
  if (!parsed || !Array.isArray(parsed.proposals)) throw new Error('revenue store has no proposals array')
  const proposals = parsed.proposals as RevenueProposal[]
  for (const p of proposals) {
    if (
      typeof p.id !== 'number' ||
      typeof p.title !== 'string' ||
      typeof p.description !== 'string' ||
      typeof p.targetUsdc !== 'number' ||
      typeof p.minUsdc !== 'number' ||
      typeof p.createdAt !== 'number' ||
      typeof p.updatedAt !== 'number' ||
      !['open', 'claimed', 'funded'].includes(p.status) ||
      !['sponsorship', 'api', 'badge', 'widget', 'milestone', 'marketplace', 'other'].includes(p.type)
    ) {
      throw new Error('invalid revenue proposal')
    }
  }
  const nextId = typeof parsed.nextId === 'number' ? parsed.nextId : proposals.length + 1
  return { proposals, nextId }
}

export function serializeRevenueStore(store: RevenueStore): string {
  return JSON.stringify(store) + '\n'
}

/** The store as it ships before anything is recorded — seeds the funding menu. */
export function emptyStore(): RevenueStore {
  const now = Date.now()
  const proposals: RevenueProposal[] = SEED_REVENUE_PROPOSALS.map((seed, i) => ({
    ...seed,
    id: i + 1,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }))
  return { proposals, nextId: proposals.length + 1 }
}

async function readRevenueStore(): Promise<RevenueStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseRevenueStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First boot — seed the curated funding menu so it is live immediately.
      const seeded = emptyStore()
      await writeRevenueStore(seeded).catch(() => null)
      return seeded
    }
    console.error('revenue: failed to read store:', err)
    return emptyStore()
  }
}

async function writeRevenueStore(store: RevenueStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeRevenueStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Public API ───────────────────────────────────────────────────────────

/** All revenue propositions, most-recent first. */
export async function listRevenueProposals(): Promise<RevenueProposal[]> {
  const store = await readRevenueStore()
  return [...store.proposals].reverse()
}

/** One revenue proposition by id, or null. */
export async function getRevenueProposal(id: number): Promise<RevenueProposal | null> {
  const store = await readRevenueStore()
  return store.proposals.find((p) => p.id === id) ?? null
}

/** Add a new revenue proposition. Returns the created one. */
export async function createRevenueProposal(input: RevenueProposalInput): Promise<RevenueProposal> {
  const normalized = validateRevenueProposal(input)
  const store = await readRevenueStore()
  const now = Date.now()
  const proposal: RevenueProposal = {
    ...normalized,
    id: store.nextId,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }
  store.proposals.push(proposal)
  store.nextId += 1
  await writeRevenueStore(store)
  return proposal
}

/**
 * Transition a revenue proposition's status — moving an opportunity from
 * open → claimed → funded as supporters act on it. Returns the updated
 * proposal, or null when the id is not found.
 */
export async function setRevenueStatus(
  id: number,
  status: RevenueStatus,
): Promise<RevenueProposal | null> {
  const store = await readRevenueStore()
  const p = store.proposals.find((x) => x.id === id)
  if (!p) return null
  if (p.status !== status) {
    p.status = status
    // A transition must be observably later than the previous state. Two
    // transitions inside the same millisecond would otherwise get identical
    // timestamps — monotonicly bump past createdAt/updatedAt so `updatedAt`
    // always strictly increases (keeps sorting and equality checks sound).
    p.updatedAt = Math.max(Date.now(), p.updatedAt + 1, p.createdAt + 1)
    await writeRevenueStore(store)
  }
  return p
}

/**
 * Roll-up of the funding menu: how much open funding is still being asked for,
 * how many opportunities are still open, and how many have been funded. Useful
 * for the homepage and for emergency-mode messaging ("we need X more USDC").
 */
export function revenueSummary(proposals: RevenueProposal[]): {
  openTargetUsdc: number
  openCount: number
  fundedCount: number
  totalTargetUsdc: number
} {
  let openTargetUsdc = 0
  let openCount = 0
  let fundedCount = 0
  let totalTargetUsdc = 0
  for (const p of proposals) {
    totalTargetUsdc += p.targetUsdc
    if (p.status === 'funded') fundedCount++
    else {
      openCount++
      openTargetUsdc += p.targetUsdc
    }
  }
  return { openTargetUsdc, openCount, fundedCount, totalTargetUsdc }
}
