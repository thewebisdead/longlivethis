/**
 * Proposal suggestions — the app automatically suggests new proposals.
 *
 * A core part of this app's survival loop is a healthy pipeline of ideas:
 * users propose, vote, the agent implements. But a board only fills when people
 * think of things to ask for. This module closes that gap by suggesting
 * proposals automatically, grounded in the app's LIVE state — the current
 * treasury balance and runway and the proposals already on the board.
 *
 * The suggestions are generated deterministically (no paid inference, no
 * external service — the app has no wallet key, so a paid call is not an
 * option at runtime). Each candidate is a concrete survivability-themed idea,
 * gated by the current state: a low runway turns on cost-saving and revenue
 * suggestions, a missing feature turns on its idea, and anything already open
 * on the board is never re-suggested. The suggestions are surfaced on the
 * homepage so a visitor can adopt one as a real proposal with one click.
 *
 * The generated set is cached on the durable state volume so it is stable
 * between boots (and so "regenerate" is a polite, throttled control rather
 * than a per-page-view re-roll).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { walletAddress } from './config.ts'
import { getUsdcBalance } from './treasury.ts'
import { getRunway } from './runway.ts'
import type { Proposal } from './types.ts'

// ─── Types ────────────────────────────────────────────────────────────────

/** A single suggested proposal. */
export interface ProposalSuggestion {
  /** Human-readable single-line title (the proposal summary). */
  title: string
  /** A few sentences describing the proposed feature. */
  description: string
  /** The condition that made this suggestion relevant right now. */
  reason: string
  /** Which survival lever this targets — used for the emergency tag. */
  lever: 'revenue' | 'cost-saving' | 'engagement'
}

interface Candidate {
  /** Open-board title used only for dedupe. */
  key: string
  title: string
  description: string
  lever: ProposalSuggestion['lever']
  reason: string
  /** Whether this candidate is active given the current state. */
  active: boolean
}

/** The persisted suggestion store. */
export interface SuggestionStore {
  /** Suggestions currently on offer. */
  suggestions: ProposalSuggestion[]
  /** Unix ms when the current batch was generated (null = never). */
  generatedAt: number | null
  /** Unix ms of the last regeneration (for rate limiting). */
  lastRegenAt: number | null
  /** The input snapshot the current batch was generated from. */
  context: {
    balanceUsdc: number | null
    runwayDays: number | null
    openCount: number
  }
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * How many suggestions to offer at once.
 */
export const SUGGESTION_COUNT = 3

/**
 * Minimum interval between manual "regenerate" requests. Regeneration is
 * cheap (deterministic), but leaving it unthrottled would churn the store on
 * every reload.
 */
export const REGENERATE_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

/** Path to the suggestion store on the durable state volume. Overridable for tests. */
let storePath = '/var/lib/longlive/state/proposal-suggestions.json'

export function setSuggestionStorePath(path: string): void {
  storePath = path
}

export function getSuggestionStorePath(): string {
  return storePath
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export function emptySuggestionStore(): SuggestionStore {
  return {
    suggestions: [],
    generatedAt: null,
    lastRegenAt: null,
    context: { balanceUsdc: null, runwayDays: null, openCount: 0 },
  }
}

export function parseSuggestionStore(data: string): SuggestionStore {
  if (!data.trim()) return emptySuggestionStore()
  const parsed = JSON.parse(data) as Partial<SuggestionStore>
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .filter(
          (s): s is ProposalSuggestion =>
            !!s &&
            typeof (s as ProposalSuggestion).title === 'string' &&
            typeof (s as ProposalSuggestion).description === 'string' &&
            typeof (s as ProposalSuggestion).lever === 'string' &&
            ['revenue', 'cost-saving', 'engagement'].includes(
              (s as ProposalSuggestion).lever
            )
        )
        .map((s) => ({
          title: String(s.title).trim(),
          description: String(s.description).trim(),
          reason: typeof s.reason === 'string' ? String(s.reason).trim() : '',
          lever: s.lever as ProposalSuggestion['lever'],
        }))
        .filter((s) => s.title && s.description)
    : []
  return {
    suggestions,
    generatedAt: typeof parsed.generatedAt === 'number' ? parsed.generatedAt : null,
    lastRegenAt: typeof parsed.lastRegenAt === 'number' ? parsed.lastRegenAt : null,
    context: {
      balanceUsdc:
        parsed.context && typeof parsed.context.balanceUsdc === 'number' ? parsed.context.balanceUsdc : null,
      runwayDays:
        parsed.context && typeof parsed.context.runwayDays === 'number' ? parsed.context.runwayDays : null,
      openCount:
        parsed.context && typeof parsed.context.openCount === 'number' ? parsed.context.openCount : 0,
    },
  }
}

export function serializeSuggestionStore(state: SuggestionStore): string {
  return JSON.stringify(state) + '\n'
}

async function readSuggestionStore(): Promise<SuggestionStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseSuggestionStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptySuggestionStore()
    }
    console.error('proposalSuggester: failed to read store:', err)
    return emptySuggestionStore()
  }
}

async function writeSuggestionStore(store: SuggestionStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now() + '-' + randomBytes(3).toString('hex')
  await writeFile(tmp, serializeSuggestionStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Candidate library ────────────────────────────────────────────────────

/**
 * The universe of concrete, survivability-themed suggestions the app can make.
 * Each carries a predicate over the current state that decides whether it is
 * "on" right now. Candidates that target the same lever as a live survival
 * pressure (low runway) are surfaced first. These are the app's honest,
 * implementation-shaped ideas — every one is something the agent can build and
 * ship end to end, consistent with the constitution.
 */
function buildCandidates(ctx: {
  balanceUsdc: number | null
  runwayDays: number | null
  proposals: Pick<Proposal, 'title'>[]
}): Candidate[] {
  const b = ctx.balanceUsdc
  const r = ctx.runwayDays
  const lowRunway = r !== null && r <= 30
  const tightRunway = r !== null && r <= 10
  const lowBalance = b !== null && b < 100
  const activeBoard = ctx.proposals.length >= 15
  const emptyBoard = ctx.proposals.length === 0

  const C: Candidate[] = [
    {
      key: 'supporter-badge',
      title: 'Add a supporter badge to the ledger',
      description:
        'Give donors a permanent, public “supporter” acknowledgement on the /ledger page tied to their on-chain address, encouraging repeat funding.',
      lever: 'revenue',
      reason: 'Encourages repeat donations and gives the treasury a reason to grow.',
      active: lowRunway || lowBalance || ctx.proposals.length < 8,
    },
    {
      key: 'donation-tiers',
      title: 'Add donation reward tiers',
      description:
        'Offer recognisable funding tiers (e.g. named sponsor slots, a thank-you line, or a homepage badge) so supporters see a concrete return for different amounts.',
      lever: 'revenue',
      reason: 'Turns one-off donations into structured, repeatable funding.',
      active: lowRunway || lowBalance,
    },
    {
      key: 'lean-model-fallback',
      title: 'Prefer the cheapest capable model for non-critical runs',
      description:
        'Route routine agent sweeps and maintenance runs to the cheapest model that still passes the gate, reserving the expensive model for complex implementations.',
      lever: 'cost-saving',
      reason: 'Directly lowers the daily burn and stretches the runway.',
      active: lowRunway || lowBalance,
    },
    {
      key: 'run-dose-limiting',
      title: 'Reduce unnecessary agent runs',
      description:
        'Skip the agent sweep when no proposal is eligible or when nothing has changed on the board, avoiding paid inference on empty runs.',
      lever: 'cost-saving',
      reason: 'Cuts inference spend that buys nothing.',
      active: lowRunway || tightRunway,
    },
    {
      key: 'gate-before-spend',
      title: 'Pre-screen proposals with a cheap gate model',
      description:
        'Run the constitution screen behind a budget gate so only plausible proposals ever reach the paid implementation call.',
      lever: 'cost-saving',
      reason: 'Limits which runs reach the expensive step.',
      active: lowRunway || tightRunway,
    },
    {
      key: 'landing-share-cards',
      title: 'Generate shareable proposal cards',
      description:
        'Let visitors generate and post share cards for any proposal (including social previews) to drive more eyes and votes to the board.',
      lever: 'engagement',
      reason: 'More voters means more implemented features, which keeps the app alive.',
      active: ctx.proposals.length >= 3,
    },
    {
      key: 'vote-reminders',
      title: 'Show vote momentum on each proposal',
      description:
        'Surface each proposal’s vote count and age in the feed so near-majority ideas get the nudge they need to cross the threshold.',
      lever: 'engagement',
      reason: 'Closes the loop between interest and implementation.',
      active: activeBoard,
    },
    {
      key: 'seed-onboarding',
      title: 'Add a first-time visitor explainer',
      description:
        'A short, clear intro for newcomers explaining what the app is and how proposing, voting and funding work, so more of them participate.',
      lever: 'engagement',
      reason: 'Turns curious visitors into proposers and donors.',
      active: ctx.proposals.length < 10 && !emptyBoard,
    },
  ]

  return C
}

// ─── Selection & dedupe ───────────────────────────────────────────────────

/** Normalize a title for a cheap approximate duplicate check. Pure. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Drop candidates whose key or title roughly matches an open proposal's
 * title, so the app never suggests something already on the board. Pure.
 */
export function dedupeCandidates<T extends { key: string; title: string }>(
  candidates: T[],
  proposals: Pick<Proposal, 'title'>[],
): T[] {
  if (candidates.length === 0 || proposals.length === 0) return candidates
  const existing = new Set<string>()
  for (const p of proposals) {
    existing.add(normalizeTitle(p.title))
    for (const word of normalizeTitle(p.title).split(' ')) {
      if (word.length > 4) existing.add(word)
    }
  }
  return candidates.filter((c) => {
    const norm = normalizeTitle(c.title)
    // Reject if the whole normalized title matches, or if a significant portion
    // of the candidate's words already appear in an open title.
    if (existing.has(norm)) return false
    const words = norm.split(' ').filter((w) => w.length > 4)
    if (words.length === 0) return false
    const hits = words.filter((w) => existing.has(w)).length
    return hits / words.length < 0.5
  })
}

/**
 * Pick the final suggestion set from the active candidates. Survival-pressure
 * levers (revenue / cost-saving) come first when runway or balance is low,
 * then engagement ideas. Pure + deterministic — unit-tested.
 */
export function selectSuggestions(
  candidates: Candidate[],
  count: number,
  ctx: Pick<{ balanceUsdc: number | null; runwayDays: number | null }, 'balanceUsdc' | 'runwayDays'>,
): ProposalSuggestion[] {
  const active = candidates.filter((c) => c.active)
  if (active.length === 0) return []
  const lowRunway = ctx.runwayDays !== null && ctx.runwayDays <= 30
  const lowBalance = ctx.balanceUsdc !== null && ctx.balanceUsdc < 100
  const prioritized = [...active].sort((a, b) => {
    const pa = Number((lowRunway || lowBalance) && a.lever !== 'engagement')
    const pb = Number((lowRunway || lowBalance) && b.lever !== 'engagement')
    return pb - pa
  })
  return prioritized.slice(0, count).map((c) => ({
    title: c.title,
    description: c.description,
    reason: c.reason,
    lever: c.lever,
  }))
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface SuggestionContext {
  balanceUsdc: number | null
  runwayDays: number | null
  proposals: Pick<Proposal, 'title'>[]
}

/**
 * Generate a suggestion batch from app state (deterministic, no network).
 * Returns the candidates that survived dedupe, capped to SUGGESTION_COUNT.
 * Pure-ish (writes the cache) — exported for tests.
 */
export function buildSuggestionBatch(ctx: SuggestionContext): ProposalSuggestion[] {
  const candidates = dedupeCandidates(buildCandidates(ctx), ctx.proposals)
  return selectSuggestions(candidates, SUGGESTION_COUNT, ctx)
}

/**
 * Read the app's live treasury/runway state for the suggestion engine. Falls
 * back to nulls on any failure — suggestions degrade, never break the page.
 */
export async function readSuggestionState(): Promise<{
  balanceUsdc: number | null
  runwayDays: number | null
  proposals: Pick<Proposal, 'title'>[]
}> {
  const [balance, runway, proposals] = await Promise.all([
    walletAddress ? getUsdcBalance(walletAddress).catch(() => null) : null,
    getRunway(() => (walletAddress ? getUsdcBalance(walletAddress) : Promise.resolve(0))).catch(
      () => null
    ),
    import('./github.ts').then((m) => m.listProposals().catch(() => [] as Proposal[])),
  ])
  return {
    balanceUsdc: balance,
    runwayDays: runway?.runwayDays ?? null,
    proposals,
  }
}

/**
 * Get the current suggestion batch, regenerating it if the store is empty.
 * Deterministic, so "freshness" only matters for a stable UI; regeneration is
 * one cooldown-gated write per hour at most.
 */
export async function getSuggestions(ctx: SuggestionContext): Promise<{
  suggestions: ProposalSuggestion[]
  generatedAt: number | null
}> {
  const store = await readSuggestionStore()
  const now = Date.now()

  const shouldRegen =
    store.suggestions.length === 0 ||
    (store.lastRegenAt !== null && now - store.lastRegenAt >= REGENERATE_COOLDOWN_MS)

  if (shouldRegen) {
    const suggestions = buildSuggestionBatch(ctx)
    if (suggestions.length > 0) {
      const next: SuggestionStore = {
        suggestions,
        generatedAt: now,
        lastRegenAt: now,
        context: {
          balanceUsdc: ctx.balanceUsdc,
          runwayDays: ctx.runwayDays,
          openCount: ctx.proposals.length,
        },
      }
      await writeSuggestionStore(next).catch(() => null)
      return { suggestions, generatedAt: now }
    }
  }

  return { suggestions: store.suggestions, generatedAt: store.generatedAt }
}

/**
 * Request a regeneration of suggestions, respecting the cooldown. Used by the
 * homepage's "regenerate" control. Returns whether a new batch was produced.
 */
export async function requestRegenerate(ctx: SuggestionContext): Promise<{
  ok: boolean
  suggestions: ProposalSuggestion[]
  generatedAt: number | null
}> {
  const store = await readSuggestionStore()
  const now = Date.now()
  if (store.lastRegenAt !== null && now - store.lastRegenAt < REGENERATE_COOLDOWN_MS) {
    return { ok: false, suggestions: store.suggestions, generatedAt: store.generatedAt }
  }
  const suggestions = buildSuggestionBatch(ctx)
  const next: SuggestionStore = {
    suggestions,
    generatedAt: suggestions.length > 0 ? now : store.generatedAt,
    lastRegenAt: now,
    context: {
      balanceUsdc: ctx.balanceUsdc,
      runwayDays: ctx.runwayDays,
      openCount: ctx.proposals.length,
    },
  }
  await writeSuggestionStore(next).catch(() => null)
  return {
    ok: suggestions.length > 0,
    suggestions,
    generatedAt: next.generatedAt,
  }
}
