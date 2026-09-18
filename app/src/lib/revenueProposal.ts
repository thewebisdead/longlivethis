/**
 * Revenue attributed to implemented proposals.
 *
 * Proposals get a category (feature / revenue / cost-saving / standard) when
 * they are filed. A proposal filed under "revenue" is an idea whose purpose is
 * to make the app money. This module tracks the OUTCOME of that idea once it
 * is implemented: how much USDC a particular revenue proposal actually pulled
 * into the treasury, so the board can show which money-making ideas paid off
 * and which didn't.
 *
 * The mapping is proposal issue number → amount (USDC), recorded on the
 * durable state volume. Recording a value is an explicit, admin-side act: the
 * app cannot infer which donor a donation came from, so a maintainer
 * attributes a treasury inflow to the proposal (e.g. in a deploy step or a
 * one-off PATCH) once the revenue materializes. The running total is surfaced
 * per-proposal on the feed and in the ledger.
 *
 * Like the feature feed, attribution is keyed by the GitHub issue number of
 * the proposal. Nothing here needs a key and everything is public — this is a
 * transparency record, not a wallet.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export interface RevenueRecord {
  /** GitHub issue number of the revenue proposal. */
  proposalId: number
  /** Amount of USDC this implemented proposal has generated, cumulative. */
  amountUsdc: number
  /** Unix ms the revenue was last recorded. */
  updatedAt: number
  /** Free-form note about the source/campaign, if any. */
  note?: string
}

export interface RevenueProposalStore {
  records: RevenueRecord[]
}
export interface ProposalRevenueInput {
  proposalId: number
  amountUsdc: number
  note?: string
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the revenue-proposal attribution store on the durable state volume.
 * Overridable for tests.
 */
let storePath = '/var/lib/longlive/state/proposal-revenue.json'

export function setProposalRevenuePath(path: string): void {
  storePath = path
}

export function getProposalRevenuePath(): string {
  return storePath
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export function parseProposalRevenueStore(data: string): RevenueProposalStore {
  if (!data.trim()) return { records: [] }
  const parsed = JSON.parse(data) as Partial<RevenueProposalStore>
  if (!parsed || !Array.isArray(parsed.records)) throw new Error('proposal revenue store has no records array')
  for (const r of parsed.records) {
    if (
      typeof r.proposalId !== 'number' ||
      typeof r.amountUsdc !== 'number' ||
      typeof r.updatedAt !== 'number'
    ) {
      throw new Error('invalid revenue record')
    }
  }
  return { records: parsed.records as RevenueRecord[] }
}

export function serializeProposalRevenueStore(store: RevenueProposalStore): string {
  return JSON.stringify(store) + '\n'
}

const emptyStore = (): RevenueProposalStore => ({ records: [] })

async function readStore(): Promise<RevenueProposalStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseProposalRevenueStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First boot — an empty revenue ledger is the correct start.
      return emptyStore()
    }
    console.error('proposal-revenue: failed to read store:', err)
    return emptyStore()
  }
}

async function writeStore(store: RevenueProposalStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeProposalRevenueStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Record revenue for an implemented proposal. If the proposal already has a
 * record, the amount is ADDED to it (cumulative attribution). Returns the
 * updated record.
 */
export async function recordProposalRevenue(input: ProposalRevenueInput): Promise<RevenueRecord> {
  const proposalId = input.proposalId
  const amountUsdc = input.amountUsdc
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    throw new Error('proposalId must be a positive integer')
  }
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error('amountUsdc must be positive')
  }
  const store = await readStore()
  const now = Date.now()
  const existing = store.records.find((r) => r.proposalId === proposalId)
  if (existing) {
    // Cumulative: each recording adds to the running total.
    existing.amountUsdc = Math.round((existing.amountUsdc + amountUsdc) * 1e6) / 1e6
    existing.updatedAt = now
    if (input.note) existing.note = input.note
  } else {
    store.records.push({
      proposalId,
      amountUsdc: Math.round(amountUsdc * 1e6) / 1e6,
      updatedAt: now,
      note: input.note,
    })
  }
  await writeStore(store)
  const rec = store.records.find((r) => r.proposalId === proposalId)!
  return rec
}

/** Revenue records, most-recently-updated first. */
export async function listProposalRevenue(): Promise<RevenueRecord[]> {
  const store = await readStore()
  return [...store.records].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Revenue attributed to one proposal, or null when none recorded yet. */
export async function getProposalRevenue(proposalId: number): Promise<RevenueRecord | null> {
  const store = await readStore()
  return store.records.find((r) => r.proposalId === proposalId) ?? null
}

/**
 * Total revenue attributed across all implemented revenue proposals, USDC.
 */
export function totalAttributedRevenue(records: RevenueRecord[]): number {
  return Math.round(records.reduce((sum, r) => sum + r.amountUsdc, 0) * 1e6) / 1e6
}
