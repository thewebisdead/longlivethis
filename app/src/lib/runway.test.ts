import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeRunway,
  parseLedger,
  serializeLedger,
  HOSTING_COST_PER_DAY,
} from './runway.ts'
import type { RunEntry } from './runway.ts'

function entry(ts: number, cost: number): RunEntry {
  return { ts, inferenceCostUsdc: cost, hostingCostUsdc: 0, totalCostUsdc: cost }
}

test('computeRunway reports safe level at >=30 days', () => {
  const now = Date.now()
  // Daily inference burn of $1 → 30 days runway at balance 30 (no hosting floor)
  const entries = Array.from({ length: 7 }, (_, i) => entry(now - i * 24 * 3600 * 1000, 1))
  const info = computeRunway(30, entries, { hostingCostPerDay: 0 })
  assert.equal(info.level, 'safe')
  assert.equal(info.policy, 'current cadence (2 runs/day), current model')
  assert.equal(info.dailyBurn, 1)
  assert.ok(info.runwayDays >= 30)
})

test('computeRunway reports reduced level at 10-30 days', () => {
  const now = Date.now()
  const entries = Array.from({ length: 7 }, (_, i) => entry(now - i * 24 * 3600 * 1000, 1))
  const info = computeRunway(15, entries, { hostingCostPerDay: 0 }) // daily burn 1 → 15 days
  assert.equal(info.level, 'reduced')
  assert.equal(info.policy, '1 run/day')
})

test('computeRunway reports critical level at 3-10 days', () => {
  const now = Date.now()
  const entries = Array.from({ length: 7 }, (_, i) => entry(now - i * 24 * 3600 * 1000, 1))
  const info = computeRunway(5, entries, { hostingCostPerDay: 0 }) // daily burn 1 → 5 days
  assert.equal(info.level, 'critical')
  assert.equal(info.policy, '1 run every 3 days, cheapest capable model, hard token cap per run')
})

test('computeRunway reports paused level below 3 days', () => {
  const now = Date.now()
  const entries = Array.from({ length: 7 }, (_, i) => entry(now - i * 24 * 3600 * 1000, 1))
  const info = computeRunway(2, entries, { hostingCostPerDay: 0 }) // daily burn 1 → 2 days
  assert.equal(info.level, 'paused')
  assert.equal(info.policy, 'no implementation runs — serve site only')
})

test('computeRunway counts the hosting floor even with an empty ledger', () => {
  // No runs recorded → burn is still the standing hosting cost, so runway is
  // finite and the feature is live from first boot rather than Infinity.
  const info = computeRunway(100, [], { hostingCostPerDay: 0.2 })
  assert.equal(info.dailyBurn, 0.2)
  assert.equal(info.runwayDays, 500)
  assert.equal(info.level, 'safe')
})

test('computeRunway returns finite runway with hosting floor when ledger is empty', () => {
  // Even with zero recorded inference, the standing hosting cost gives a
  // finite, meaningful runway from first boot.
  const info = computeRunway(100, [])
  assert.equal(info.runwayDays, 500) // 100 / 0.2 = 500
  assert.equal(info.level, 'safe')
  assert.equal(info.dailyBurn, 0.2)
})

test('computeRunway only counts the trailing 7-day window', () => {
  const now = Date.now()
  const oldEntry = entry(now - 10 * 24 * 3600 * 1000, 100) // 10 days ago — outside window
  const recentEntry = entry(now - 24 * 3600 * 1000, 7) // 1 day ago
  // 7-day avg inference of $1/day + hosting $0 = $1/day
  const info = computeRunway(100, [oldEntry, recentEntry], { hostingCostPerDay: 0 })
  assert.equal(info.runsInWindow, 1)
  assert.equal(info.totalBurnInWindow, 7)
  assert.equal(info.dailyBurn, 1)
})

test('ledger round-trips through serialize/parse', () => {
  const entries: RunEntry[] = [
    { ts: 1000, inferenceCostUsdc: 0.5, hostingCostUsdc: 0.2, totalCostUsdc: 0.7 },
    { ts: 2000, inferenceCostUsdc: 0.3, hostingCostUsdc: 0.1, totalCostUsdc: 0.4 },
  ]
  const parsed = parseLedger(serializeLedger(entries))
  assert.deepEqual(parsed, entries)
})

test('parseLedger rejects malformed data', () => {
  assert.throws(() => parseLedger('not json'), SyntaxError)
  assert.throws(() => parseLedger('{}'), /not an array/)
  assert.throws(() => parseLedger('[{"ts":"x"}]'), /invalid ledger entry shape/)
})

test('parseLedger returns [] for empty input', () => {
  assert.deepEqual(parseLedger(''), [])
})

test('hosting cost estimate is a positive number', () => {
  assert.ok(HOSTING_COST_PER_DAY > 0)
})
