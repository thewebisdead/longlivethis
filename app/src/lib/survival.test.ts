import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  computeSurvivalLevel,
  survivalPolicy,
  isEmergencyPriority,
  proposalPriorityLabel,
  parseSurvivalState,
  serializeSurvivalState,
  EMPTY_SURVIVAL_STATE,
  DEFAULT_EMERGENCY_THRESHOLD_DAYS,
  WATCH_THRESHOLD_DAYS,
  evaluateSurvivalMode,
  recordSkippedRun,
  recordDownshiftedRun,
  recordPriorityProposal,
  getSurvivalInfo,
  setSurvivalStatePath,
  getSurvivalStatePath,
} from './survival.ts'
import type { SurvivalLevel, SurvivalState } from './survival.ts'

// ─── Level computation ────────────────────────────────────────────────────

test('computeSurvivalLevel returns normal above watch threshold', () => {
  assert.equal(computeSurvivalLevel(60), 'normal')
  assert.equal(computeSurvivalLevel(WATCH_THRESHOLD_DAYS + 1), 'normal')
})

test('computeSurvivalLevel returns watch between threshold and watch threshold', () => {
  assert.equal(computeSurvivalLevel(40), 'watch')
  assert.equal(computeSurvivalLevel(DEFAULT_EMERGENCY_THRESHOLD_DAYS + 1), 'watch')
  assert.equal(computeSurvivalLevel(WATCH_THRESHOLD_DAYS), 'watch')
})

test('computeSurvivalLevel returns emergency at or below threshold', () => {
  assert.equal(computeSurvivalLevel(DEFAULT_EMERGENCY_THRESHOLD_DAYS), 'emergency')
  assert.equal(computeSurvivalLevel(15), 'emergency')
  assert.equal(computeSurvivalLevel(11), 'emergency')
})

test('computeSurvivalLevel returns critical at or below 10 days', () => {
  assert.equal(computeSurvivalLevel(10), 'critical')
  assert.equal(computeSurvivalLevel(5), 'critical')
  assert.equal(computeSurvivalLevel(4), 'critical')
})

test('computeSurvivalLevel returns paused at or below 3 days', () => {
  assert.equal(computeSurvivalLevel(3), 'paused')
  assert.equal(computeSurvivalLevel(1), 'paused')
  assert.equal(computeSurvivalLevel(0), 'paused')
})

test('computeSurvivalLevel respects custom threshold', () => {
  assert.equal(computeSurvivalLevel(20, 15), 'watch') // 20 > 15 and < 45 -> watch
  assert.equal(computeSurvivalLevel(15, 15), 'emergency')
  // 10 is <= critical threshold (10), so critical wins over emergency
  assert.equal(computeSurvivalLevel(10, 15), 'critical')
  assert.equal(computeSurvivalLevel(12, 15), 'emergency') // 12 > 10, <= 15
})

// ─── Policy descriptions ──────────────────────────────────────────────────

test('survivalPolicy returns a description for every level', () => {
  const levels: SurvivalLevel[] = ['normal', 'watch', 'emergency', 'critical', 'paused']
  for (const level of levels) {
    const policy = survivalPolicy(level)
    assert.ok(typeof policy === 'string', `policy for ${level} should be a string`)
    assert.ok(policy.length > 10, `policy for ${level} should be descriptive`)
  }
})

// ─── Priority detection ───────────────────────────────────────────────────

test('isEmergencyPriority detects cost-saving proposals', () => {
  assert.equal(isEmergencyPriority('We should lower costs by using a cheaper model'), true)
  assert.equal(isEmergencyPriority('Reduce cost of inference by batching'), true)
  assert.equal(isEmergencyPriority('Optimize cost of agent runs'), true)
  assert.equal(isEmergencyPriority('Cut the spend on unnecessary executions'), true)
  assert.equal(isEmergencyPriority('Free tier for basic proposals'), true)
})

test('isEmergencyPriority detects revenue-generating proposals', () => {
  assert.equal(isEmergencyPriority('Generate revenue through donations'), true)
  assert.equal(isEmergencyPriority('Earn money by selling API access'), true)
  assert.equal(isEmergencyPriority('Fundraising campaign for the treasury'), true)
  assert.equal(isEmergencyPriority('Monetize the app features'), true)
  assert.equal(isEmergencyPriority('Make money from the site'), true)
})

test('isEmergencyPriority returns false for neutral proposals', () => {
  assert.equal(isEmergencyPriority('Add a dark mode toggle'), false)
  assert.equal(isEmergencyPriority('Fix the homepage layout'), false)
  assert.equal(isEmergencyPriority('Add a new game feature'), false)
  assert.equal(isEmergencyPriority('Improve the typography'), false)
})

test('proposalPriorityLabel returns the correct label', () => {
  assert.equal(proposalPriorityLabel('We should lower costs'), 'cost-saving')
  assert.equal(proposalPriorityLabel('Generate revenue via ads'), 'revenue')
  assert.equal(proposalPriorityLabel('Fix the homepage'), 'standard')
})

// ─── State serialization ──────────────────────────────────────────────────

test('parseSurvivalState returns empty state for empty input', () => {
  assert.deepEqual(parseSurvivalState(''), EMPTY_SURVIVAL_STATE)
})

test('parseSurvivalState parses a complete state', () => {
  const state: SurvivalState = {
    level: 'emergency',
    runwayDays: 15,
    dailyBurn: 1.5,
    enteredAt: 1000,
    lastTransition: 1001,
    runsSkipped: 2,
    runsDownshifted: 1,
    costSavingProposals: 3,
    revenueProposals: 1,
    everBeenInEmergency: true,
  }
  const parsed = parseSurvivalState(serializeSurvivalState(state))
  assert.deepEqual(parsed, state)
})

test('parseSurvivalState tolerates partial / missing fields', () => {
  const parsed = parseSurvivalState('{}')
  assert.equal(parsed.level, 'normal')
  assert.equal(parsed.enteredAt, null)
  assert.equal(parsed.runsSkipped, 0)
  assert.equal(parsed.everBeenInEmergency, false)
})

test('parseSurvivalState rejects invalid level gracefully', () => {
  const parsed = parseSurvivalState('{"level":"invalid"}')
  assert.equal(parsed.level, 'normal')
})

test('state round-trips through serialize/parse', () => {
  const states: SurvivalState[] = [
    EMPTY_SURVIVAL_STATE,
    { level: 'emergency', runwayDays: 20, dailyBurn: 0.5, enteredAt: 100, lastTransition: 101, runsSkipped: 0, runsDownshifted: 0, costSavingProposals: 0, revenueProposals: 0, everBeenInEmergency: true },
    { level: 'normal', runwayDays: 100, dailyBurn: 0.1, enteredAt: null, lastTransition: 200, runsSkipped: 5, runsDownshifted: 3, costSavingProposals: 2, revenueProposals: 1, everBeenInEmergency: true },
  ]
  for (const s of states) {
    const parsed = parseSurvivalState(serializeSurvivalState(s))
    assert.deepEqual(parsed, s)
  }
})

// ─── Default threshold ────────────────────────────────────────────────────

test('DEFAULT_EMERGENCY_THRESHOLD_DAYS is 30', () => {
  assert.equal(DEFAULT_EMERGENCY_THRESHOLD_DAYS, 30)
})

test('WATCH_THRESHOLD_DAYS is 45', () => {
  assert.equal(WATCH_THRESHOLD_DAYS, 45)
})

// ─── End-to-end state machine (file I/O) ─────────────────────────────────

// Isolate each test's state file.
function useTempPath(): string {
  const p = join(tmpdir(), `survival-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  setSurvivalStatePath(p)
  return p
}

async function cleanup(path: string): Promise<void> {
  await unlink(path).catch(() => null)
}

test('setSurvivalStatePath/getSurvivalStatePath round-trip', () => {
  const orig = getSurvivalStatePath()
  setSurvivalStatePath('/tmp/test-survival.json')
  assert.equal(getSurvivalStatePath(), '/tmp/test-survival.json')
  setSurvivalStatePath(orig)
})

test('evaluateSurvivalMode transitions into emergency and records entrance', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  const state = await evaluateSurvivalMode({ runwayDays: 20, dailyBurn: 1, level: 'reduced' }, 30)
  assert.equal(state.level, 'emergency')
  assert.equal(state.enteredAt, state.lastTransition)
  assert.equal(state.everBeenInEmergency, true)
  await cleanup(path)
})

test('evaluateSurvivalMode recovers to normal and clears counters', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  // Enter emergency first.
  await evaluateSurvivalMode({ runwayDays: 20, dailyBurn: 1, level: 'reduced' }, 30)
  await recordSkippedRun()
  await recordDownshiftedRun()
  // Recover.
  await evaluateSurvivalMode({ runwayDays: 100, dailyBurn: 0.2, level: 'safe' }, 30)
  const state = await getSurvivalInfo(30)
  assert.equal(state.level, 'normal')
  assert.equal(state.enteredAt, null)
  assert.equal(state.runsSkipped, 0)
  assert.equal(state.runsDownshifted, 0)
  assert.equal(state.everBeenInEmergency, true) // history retained
  await cleanup(path)
})

test('recordSkippedRun increments the counter', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  await recordSkippedRun()
  await recordSkippedRun()
  const info = await getSurvivalInfo(30)
  assert.equal(info.runsSkipped, 2)
  await cleanup(path)
})

test('recordPriorityProposal only counts cost-saving and revenue texts', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  await recordPriorityProposal('We should lower costs')
  await recordPriorityProposal('Generate revenue via ads')
  await recordPriorityProposal('Fix the homepage') // neutral — not counted
  const info = await getSurvivalInfo(30)
  assert.equal(info.costSavingProposals, 1)
  assert.equal(info.revenueProposals, 1)
  await cleanup(path)
})

test('evaluateSurvivalMode keeps the same level when runway barely changes', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  await evaluateSurvivalMode({ runwayDays: 20, dailyBurn: 1, level: 'reduced' }, 30) // emergency
  const first = await evaluateSurvivalMode({ runwayDays: 21, dailyBurn: 1, level: 'reduced' }, 30) // still emergency
  assert.equal(first.level, 'emergency')
  const info = await getSurvivalInfo(30)
  assert.ok(info.enteredAt !== null) // still considered in emergency
  await cleanup(path)
})
