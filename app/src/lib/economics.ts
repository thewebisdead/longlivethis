/**
 * Actual proposal economics — the realized outcome of an implemented proposal.
 *
 * Proposals carry an ESTIMATE when they are filed (see ProposalEconomics in
 * types.ts and the embed/parse helpers in github.ts). This module tracks the
 * OTHER side of that coin: what a proposal actually cost once it was built and
 * run, and what it actually returned. Together the two let the board show an
 * "estimate vs actual" comparison — which money-making ideas paid off, which
 * features overran their budget, and how the estimate held up against reality.
 *
 * The mapping is proposal issue number → actual economics, recorded on the
 * durable state volume (STATE_DIR/proposal-economics.json). Recording a value
 * is an explicit, admin-side act: the app cannot infer cost or benefit on its
 * own, so a maintainer records it once the feature has shipped and had time to
 * live (e.g. a deploy step or a one-off PATCH). Every field is optional — an
 * implemented proposal that only wanted to be cheaper may record a cost and a
 * savings benefit but no recurring cost.
 *
 * Like the feature feed, attribution is keyed by GitHub issue number. Nothing
 * here needs a key and everything is public — this is a transparency record,
 * not a wallet.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export interface ActualEconomics {
  /** GitHub issue number of the proposal. */
  proposalId: number
  /** Actual one-time implementation cost, USDC. Null when not measured. */
  actualCostUsdc: number | null
  /** Actual recurring cost while live, USDC per funding cycle. */
  actualRecurringCostUsdc: number | null
  /** Actual benefit (revenue or savings) per cycle, USDC. */
  actualBenefitUsdc: number | null
  /** Unix ms the outcome was last recorded. */
  updatedAt: number
  /** Free-form note about how the figures were measured, if any. */
  note?: string
}

export interface EconomicsStore {
  records: ActualEconomics[]
}

export interface ActualEconomicsInput {
  proposalId: number
  actualCostUsdc?: number | null
  actualRecurringCostUsdc?: number | null
  actualBenefitUsdc?: number | null
  note?: string
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the actual-economics store on the durable state volume. Overridable
 * for tests.
 */
let storePath = '/var/lib/longlive/state/proposal-economics.json'

export function setProposalEconomicsPath(path: string): void {
  storePath = path
}

export function getProposalEconomicsPath(): string {
  return storePath
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export function parseEconomicsStore(data: string): EconomicsStore {
  if (!data.trim()) return { records: [] }
  const parsed = JSON.parse(data) as Partial<EconomicsStore>
  if (!parsed || !Array.isArray(parsed.records)) throw new Error('economics store has no records array')
  for (const r of parsed.records) {
    if (
      typeof r.proposalId !== 'number' ||
      typeof r.updatedAt !== 'number' ||
      (r.actualCostUsdc != null && typeof r.actualCostUsdc !== 'number') ||
      (r.actualRecurringCostUsdc != null && typeof r.actualRecurringCostUsdc !== 'number') ||
      (r.actualBenefitUsdc != null && typeof r.actualBenefitUsdc !== 'number')
    ) {
      throw new Error('invalid economics record')
    }
  }
  return { records: parsed.records as ActualEconomics[] }
}

export function serializeEconomicsStore(store: EconomicsStore): string {
  return JSON.stringify(store) + '\n'
}

const emptyStore = (): EconomicsStore => ({ records: [] })

async function readStore(): Promise<EconomicsStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseEconomicsStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First boot — an empty actual-economics ledger is the correct start.
      return emptyStore()
    }
    console.error('economics: failed to read store:', err)
    return emptyStore()
  }
}

async function writeStore(store: EconomicsStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeEconomicsStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Public API ───────────────────────────────────────────────────────────

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * Record the actual outcome for an implemented proposal. Recording replaces
 * the current actual values (the outcome is one measurement, not cumulative —
 * unlike revenue attribution, where inflows add up). Returns the updated
 * record.
 */
export async function recordActualEconomics(input: ActualEconomicsInput): Promise<ActualEconomics> {
  const proposalId = input.proposalId
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    throw new Error('proposalId must be a positive integer')
  }
  for (const [name, value] of [
    ['actualCostUsdc', input.actualCostUsdc],
    ['actualRecurringCostUsdc', input.actualRecurringCostUsdc],
    ['actualBenefitUsdc', input.actualBenefitUsdc],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative number`)
    }
  }
  const store = await readStore()
  const now = Date.now()
  const existing = store.records.find((r) => r.proposalId === proposalId)
  const record: ActualEconomics = {
    proposalId,
    actualCostUsdc: input.actualCostUsdc != null ? round6(input.actualCostUsdc) : null,
    actualRecurringCostUsdc:
      input.actualRecurringCostUsdc != null ? round6(input.actualRecurringCostUsdc) : null,
    actualBenefitUsdc: input.actualBenefitUsdc != null ? round6(input.actualBenefitUsdc) : null,
    updatedAt: now,
    note: input.note,
  }
  if (existing) {
    existing.actualCostUsdc = record.actualCostUsdc
    existing.actualRecurringCostUsdc = record.actualRecurringCostUsdc
    existing.actualBenefitUsdc = record.actualBenefitUsdc
    existing.updatedAt = record.updatedAt
    if (input.note) existing.note = input.note
  } else {
    store.records.push(record)
  }
  await writeStore(store)
  return store.records.find((r) => r.proposalId === proposalId)!
}

/** Actual-economics records for all proposals, most-recently-updated first. */
export async function listActualEconomics(): Promise<ActualEconomics[]> {
  const store = await readStore()
  return [...store.records].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Actual economics for one proposal, or null when none recorded yet. */
export async function getActualEconomics(proposalId: number): Promise<ActualEconomics | null> {
  const store = await readStore()
  return store.records.find((r) => r.proposalId === proposalId) ?? null
}

/** Number of proposals that have a recorded actual outcome. */
export function actualEconomicsCount(records: ActualEconomics[]): number {
  return records.filter(
    (r) => r.actualCostUsdc != null || r.actualRecurringCostUsdc != null || r.actualBenefitUsdc != null,
  ).length
}
