/**
 * Emergency Survival Mode.
 *
 * When treasury runway drops below a configurable threshold, the app enters
 * emergency survival mode: it reduces unnecessary AI executions, prioritizes
 * proposals that reduce costs or generate revenue, and returns to normal mode
 * when runway recovers.
 *
 * This is a state machine stored on the durable state volume, read by the
 * spend guard (spendGuard.ts) and the agent trigger (agentTrigger.ts) to
 * adjust spending behaviour.
 *
 * The threshold is configured via the EMERGENCY_THRESHOLD_DAYS env var
 * (default 30 days), which maps to the "reduced" runway level. At or below
 * that threshold, emergency mode engages.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import type { RunwayInfo } from './runway.ts'

// ─── Types ────────────────────────────────────────────────────────────────

export type SurvivalLevel = 'normal' | 'watch' | 'emergency' | 'critical' | 'paused'

export interface SurvivalState {
  /** Current survival mode level. */
  level: SurvivalLevel
  /** Runway days at last check. */
  runwayDays: number
  /** Daily burn at last check. */
  dailyBurn: number
  /** Unix ms when emergency mode was entered (null if not in emergency). */
  enteredAt: number | null
  /** Unix ms of the last state change. */
  lastTransition: number
  /** Number of runs skipped since entering emergency. */
  runsSkipped: number
  /** Number of runs downshifted since entering emergency. */
  runsDownshifted: number
  /** Proposals that reduce costs (counted since mode entered). */
  costSavingProposals: number
  /** Proposals that generate revenue (counted since mode entered). */
  revenueProposals: number
  /** Whether the mode was ever entered (persists across restarts). */
  everBeenInEmergency: boolean
}

export const EMPTY_SURVIVAL_STATE: SurvivalState = {
  level: 'normal',
  runwayDays: Infinity,
  dailyBurn: 0,
  enteredAt: null,
  lastTransition: Date.now(),
  runsSkipped: 0,
  runsDownshifted: 0,
  costSavingProposals: 0,
  revenueProposals: 0,
  everBeenInEmergency: false,
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Default threshold in runway days below which emergency mode engages.
 * Configurable via EMERGENCY_THRESHOLD_DAYS env var.
 */
export const DEFAULT_EMERGENCY_THRESHOLD_DAYS = 30

/**
 * The runway level at which emergency mode is considered "watch" (approaching).
 */
export const WATCH_THRESHOLD_DAYS = 45

/**
 * Path to the survival state file on the durable state volume. Overridable for
 * tests.
 */
let statePath = '/var/lib/longlive/state/survival-mode.json'

export function setSurvivalStatePath(path: string): void {
  statePath = path
}

export function getSurvivalStatePath(): string {
  return statePath
}

// ─── State I/O ────────────────────────────────────────────────────────────

export function parseSurvivalState(data: string): SurvivalState {
  if (!data.trim()) return { ...EMPTY_SURVIVAL_STATE }
  const parsed = JSON.parse(data) as Partial<SurvivalState>
  return {
    level: ['normal', 'watch', 'emergency', 'critical', 'paused'].includes(parsed.level ?? '')
      ? (parsed.level as SurvivalLevel)
      : 'normal',
    runwayDays: typeof parsed.runwayDays === 'number' ? parsed.runwayDays : Infinity,
    dailyBurn: typeof parsed.dailyBurn === 'number' ? parsed.dailyBurn : 0,
    enteredAt: typeof parsed.enteredAt === 'number' ? parsed.enteredAt : null,
    lastTransition: typeof parsed.lastTransition === 'number' ? parsed.lastTransition : Date.now(),
    runsSkipped: typeof parsed.runsSkipped === 'number' ? parsed.runsSkipped : 0,
    runsDownshifted: typeof parsed.runsDownshifted === 'number' ? parsed.runsDownshifted : 0,
    costSavingProposals: typeof parsed.costSavingProposals === 'number' ? parsed.costSavingProposals : 0,
    revenueProposals: typeof parsed.revenueProposals === 'number' ? parsed.revenueProposals : 0,
    everBeenInEmergency: typeof parsed.everBeenInEmergency === 'boolean' ? parsed.everBeenInEmergency : false,
  }
}

export function serializeSurvivalState(state: SurvivalState): string {
  return JSON.stringify(state) + '\n'
}

async function readSurvivalState(): Promise<SurvivalState> {
  try {
    const data = await readFile(statePath, 'utf8')
    return parseSurvivalState(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_SURVIVAL_STATE }
    }
    console.error('survival: failed to read state:', err)
    return { ...EMPTY_SURVIVAL_STATE }
  }
}

async function writeSurvivalState(state: SurvivalState): Promise<void> {
  const dir = statePath.substring(0, statePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = statePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeSurvivalState(state), 'utf8')
  await rename(tmp, statePath)
}

// ─── State machine ────────────────────────────────────────────────────────

/**
 * Compute the survival level from runway info and the configured threshold.
 *
 * The levels are:
 * - `normal`    — runway >= WATCH_THRESHOLD_DAYS (45 days): full operation.
 * - `watch`     — runway between EMERGENCY_THRESHOLD and WATCH_THRESHOLD:
 *                 monitoring mode, agent runs proceed normally but we're watching.
 * - `emergency` — runway <= EMERGENCY_THRESHOLD (default 30 days):
 *                 reduce runs, prioritize cost-saving proposals.
 * - `critical`  — runway <= 10 days: downshift all runs, leanest spend.
 * - `paused`    — runway <= 3 days: no implementation runs, serve site only.
 */
export function computeSurvivalLevel(
  runwayDays: number,
  thresholdDays: number = DEFAULT_EMERGENCY_THRESHOLD_DAYS,
): SurvivalLevel {
  if (runwayDays <= 3) return 'paused'
  if (runwayDays <= 10) return 'critical'
  if (runwayDays <= thresholdDays) return 'emergency'
  if (runwayDays <= WATCH_THRESHOLD_DAYS) return 'watch'
  return 'normal'
}

/**
 * Decode the survival level into a human-readable policy description.
 */
export function survivalPolicy(level: SurvivalLevel, thresholdDays: number = DEFAULT_EMERGENCY_THRESHOLD_DAYS): string {
  switch (level) {
    case 'normal':
      return 'Normal operation — full agent cadence, all proposal types welcome.'
    case 'watch':
      return `Watch mode (runway ${WATCH_THRESHOLD_DAYS} days or less) — monitoring treasury, all proposals accepted.`
    case 'emergency':
      return `EMERGENCY MODE (runway ${thresholdDays} days or less) — reduced agent runs, prioritizing proposals that lower costs or generate revenue. Cost-saving and revenue-generating proposals get priority.`
    case 'critical':
      return 'CRITICAL MODE (runway 10 days or less) — heavily reduced agent runs, cheapest capable model, strict token cap. Only cost-saving or revenue-generating proposals considered.'
    case 'paused':
      return 'PAUSED (runway 3 days or less) — no implementation runs, serving site only. Fund the treasury or lower costs to resume.'
  }
}

/**
 * Whether a proposal type aligns with emergency-mode priorities.
 * Returns true for proposals that reduce costs or generate revenue.
 *
 * This is a heuristic based on proposal text analysis. It checks for keywords
 * that suggest cost-reduction or revenue-generation intent. The goal is to
 * flag such proposals for priority treatment, not to gate them.
 */
export function isEmergencyPriority(text: string): boolean {
  const lower = text.toLowerCase()
  // Cost-saving signals
  const costSaving = isCostSaving(lower)
  // Revenue-generating signals
  const revenue = isRevenue(lower)
  return costSaving || revenue
}

function isCostSaving(lower: string): boolean {
  return (
    /\b(lower costs?|reduce costs?|cut costs?|cut (the )?spend|save money|cheaper?|spend less|cost reduction|optimize costs?|reduce (spend|burn|inference))\b/.test(lower) ||
    /\b(free tier|cheaper? (model|inference|runs?|executions?)|reduce (run|execution|trigger)|fewer runs|unnecessary (run|execution|spend))\b/.test(lower)
  )
}

function isRevenue(lower: string): boolean {
  return (
    /\b(generat(e|ing) revenue|earn money|fundrais(e|ing)|donation|funding|income|monetize|make money|bring in (funds|usdc))\b/.test(lower) ||
    /\b(attract (donors|funding)|revenue (stream|generation)|profit|financial support)\b/.test(lower)
  )
}

/**
 * Get the priority label for a proposal based on its text.
 */
export function proposalPriorityLabel(text: string): 'cost-saving' | 'revenue' | 'standard' {
  const lower = text.toLowerCase()
  if (isCostSaving(lower)) return 'cost-saving'
  if (isRevenue(lower)) return 'revenue'
  return 'standard'
}

/**
 * Evaluate the current runway and update survival mode state.
 * Returns the current state after evaluation.
 *
 * Call this periodically (e.g. before each agent trigger decision).
 */
export async function evaluateSurvivalMode(
  runwayInfo: Pick<RunwayInfo, 'runwayDays' | 'dailyBurn' | 'level'>,
  thresholdDays: number = DEFAULT_EMERGENCY_THRESHOLD_DAYS,
): Promise<SurvivalState> {
  const state = await readSurvivalState()
  const newLevel = computeSurvivalLevel(runwayInfo.runwayDays, thresholdDays)

  // Detect state transitions
  const changed = newLevel !== state.level

  if (changed) {
    const now = Date.now()
    const next: SurvivalState = {
      ...state,
      level: newLevel,
      runwayDays: runwayInfo.runwayDays,
      dailyBurn: runwayInfo.dailyBurn,
      lastTransition: now,
      everBeenInEmergency: state.everBeenInEmergency || ['emergency', 'critical', 'paused'].includes(newLevel),
    }

    // Record when we enter emergency (or any restricted mode)
    if (['emergency', 'critical', 'paused'].includes(newLevel) && !['emergency', 'critical', 'paused'].includes(state.level)) {
      next.enteredAt = now
    }

    // Clear entrance time when recovering back to normal/watch
    if (['normal', 'watch'].includes(newLevel) && state.enteredAt !== null) {
      next.enteredAt = null
      // Reset counters on recovery
      next.runsSkipped = 0
      next.runsDownshifted = 0
      next.costSavingProposals = 0
      next.revenueProposals = 0
    }

    await writeSurvivalState(next)
    return next
  }

  // No transition — persist the latest runway values so the UI's displayed
  // figures stay fresh (cheap relative to a mode flip; a write here is rare
  // because it only fires on a page-trigger attempt).
  if (state.runwayDays !== runwayInfo.runwayDays || state.dailyBurn !== runwayInfo.dailyBurn) {
    await writeSurvivalState({
      ...state,
      runwayDays: runwayInfo.runwayDays,
      dailyBurn: runwayInfo.dailyBurn,
    })
    return { ...state, runwayDays: runwayInfo.runwayDays, dailyBurn: runwayInfo.dailyBurn }
  }
  return state
}

/**
 * Record that a run was skipped. Call from agentTrigger when the spend guard
 * decides to skip.
 */
export async function recordSkippedRun(): Promise<void> {
  const state = await readSurvivalState()
  state.runsSkipped++
  await writeSurvivalState(state)
}

/**
 * Record that a run was downshifted. Call from agentTrigger when the spend
 * guard decides to downshift.
 */
export async function recordDownshiftedRun(): Promise<void> {
  const state = await readSurvivalState()
  state.runsDownshifted++
  await writeSurvivalState(state)
}

/**
 * Record that an emergency-priority proposal was created (cost-saving or
 * revenue-generating). Call from the proposals POST route.
 */
export async function recordPriorityProposal(text: string): Promise<void> {
  const label = proposalPriorityLabel(text)
  if (label === 'standard') return // only record emergency-priority ones
  const state = await readSurvivalState()
  if (label === 'cost-saving') state.costSavingProposals++
  if (label === 'revenue') state.revenueProposals++
  await writeSurvivalState(state)
}

/**
 * Get the current survival mode state (no side effects).
 */
export async function getSurvivalState(): Promise<SurvivalState> {
  return readSurvivalState()
}

/**
 * Get the current survival mode level and a summary, suitable for API responses
 * and UI display.
 */
export interface SurvivalInfo {
  level: SurvivalLevel
  label: string
  active: boolean
  policy: string
  enteredAt: number | null
  runsSkipped: number
  runsDownshifted: number
  costSavingProposals: number
  revenueProposals: number
  everBeenInEmergency: boolean
  runwayDays: number
  dailyBurn: number
}

/**
 * Get survival info for display. Fetches current state and enriches with
 * derived fields. No side effects beyond reading state.
 */
export async function getSurvivalInfo(
  thresholdDays: number = DEFAULT_EMERGENCY_THRESHOLD_DAYS,
): Promise<SurvivalInfo> {
  const state = await readSurvivalState()
  const active = ['emergency', 'critical', 'paused'].includes(state.level)
  const label = state.level.charAt(0).toUpperCase() + state.level.slice(1)
  return {
    level: state.level,
    label,
    active,
    policy: survivalPolicy(state.level, thresholdDays),
    enteredAt: state.enteredAt,
    runsSkipped: state.runsSkipped,
    runsDownshifted: state.runsDownshifted,
    costSavingProposals: state.costSavingProposals,
    revenueProposals: state.revenueProposals,
    everBeenInEmergency: state.everBeenInEmergency,
    runwayDays: state.runwayDays,
    dailyBurn: state.dailyBurn,
  }
}
