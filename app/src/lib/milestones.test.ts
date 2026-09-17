import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MILESTONE_DEFS,
  milestoneById,
  parseMilestoneStore,
  serializeMilestoneStore,
  emptyMilestoneStore,
  ageDaysFrom,
  evaluateMilestones,
  getMilestoneTimeline,
  timelineFromStore,
  setMilestonesPath,
  getMilestonesPath,
  settleBirthdate,
} from './milestones.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'milestones-test-'))
}

const DAY = 24 * 60 * 60 * 1000

// ─── Definitions ──────────────────────────────────────────────────────────

test('milestone definitions cover the proposal list', () => {
  const labels = MILESTONE_DEFS.map((d) => d.label)
  assert.ok(labels.includes('7 days alive'))
  assert.ok(labels.includes('30 days alive'))
  assert.ok(labels.includes('100 proposals'))
  assert.ok(labels.includes('$100 earned'))
  assert.ok(labels.includes('50 autonomous deployments'))
})

test('every milestone has a unique id', () => {
  const ids = MILESTONE_DEFS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('milestoneById finds or returns undefined', () => {
  assert.equal(milestoneById('age-7')?.label, '7 days alive')
  assert.equal(milestoneById('nope'), undefined)
})

// ─── Age ──────────────────────────────────────────────────────────────────

test('ageDaysFrom is 0 at or before birth', () => {
  const born = Date.now()
  assert.equal(ageDaysFrom(born, born), 0)
  assert.equal(ageDaysFrom(born, born - 1000), 0)
  assert.equal(ageDaysFrom(0, Date.now()), 0)
})

test('ageDaysFrom counts full 24h days', () => {
  const born = 1_000_000
  assert.equal(ageDaysFrom(born, born + DAY - 1), 0) // just under 1 day
  assert.equal(ageDaysFrom(born, born + DAY), 1)
  assert.equal(ageDaysFrom(born, born + 7 * DAY), 7)
  assert.equal(ageDaysFrom(born, born + 30 * DAY), 30)
})

// ─── State serialization ──────────────────────────────────────────────────

test('empty store round-trips', () => {
  assert.deepEqual(parseMilestoneStore(''), emptyMilestoneStore())
  const s = emptyMilestoneStore()
  assert.deepEqual(parseMilestoneStore(serializeMilestoneStore(s)), s)
})

test('serialize/parse preserves bornAt and achieved milestones', () => {
  const store = {
    bornAt: 12345,
    achieved: {
      'age-7': {
        def: milestoneById('age-7')!,
        value: 7,
        achievedAt: 54321,
      },
    },
  }
  const parsed = parseMilestoneStore(serializeMilestoneStore(store))
  assert.equal(parsed.bornAt, 12345)
  assert.equal(parsed.achieved['age-7'].value, 7)
  assert.equal(parsed.achieved['age-7'].achievedAt, 54321)
})

test('parse tolerates unknown milestone ids', () => {
  const parsed = parseMilestoneStore('{"bornAt":1,"achieved":{"bogus":{"value":5,"achievedAt":2}}}')
  assert.deepEqual(parsed.achieved, {})
})

test('parse tolerates partial/malformed records', () => {
  const parsed = parseMilestoneStore(JSON.stringify({
    bornAt: 1,
    achieved: {
      'age-7': { value: 7 }, // missing achievedAt
      'age-30': null,
    },
  }))
  assert.deepEqual(parsed.achieved, {})
})

test('setMilestonesPath/getMilestonesPath round-trip', () => {
  const orig = getMilestonesPath()
  setMilestonesPath('/tmp/milestones-test.json')
  assert.equal(getMilestonesPath(), '/tmp/milestones-test.json')
  setMilestonesPath(orig)
})

// ─── Birthdate settlement ─────────────────────────────────────────────────

test('settleBirthdate seeds from the clock on first boot and persists', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const before = Date.now()
    const born = await settleBirthdate(null)
    assert.ok(born >= before - 100 && born <= Date.now())
    // The store now remembers it — calling again returns the same.
    assert.equal(await settleBirthdate(null), born)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settleBirthdate accepts an explicit anchor (oldest ledger entry)', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const anchor = 1_000_000
    assert.equal(await settleBirthdate(anchor), anchor)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settleBirthdate never makes the app younger once set', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const anchor = 1_000_000
    assert.equal(await settleBirthdate(anchor), anchor)
    // A later (younger) anchor is ignored — bornAt stays at the earlier value.
    assert.equal(await settleBirthdate(anchor + 100_000), anchor)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ─── Evaluation ───────────────────────────────────────────────────────────

test('evaluateMilestones records a newly-crossed milestone once', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const stats = { ageDays: 7, proposalCount: 0, earnedUsdc: 0, deploymentCount: 0 }
    const store = await evaluateMilestones(stats)
    assert.ok(store.achieved['age-7'])
    assert.equal(store.achieved['age-7'].value, 7)
    assert.ok(!store.achieved['age-30'])
    // Re-evaluating the same stats does not change the achievedAt (idempotent).
    const again = await evaluateMilestones(stats)
    assert.equal(again.achieved['age-7'].achievedAt, store.achieved['age-7'].achievedAt)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evaluateMilestones records all crossed milestones', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const store = await evaluateMilestones({
      ageDays: 60,
      proposalCount: 120,
      earnedUsdc: 150,
      deploymentCount: 60,
    })
    for (const def of MILESTONE_DEFS) {
      assert.ok(store.achieved[def.id], `expected ${def.id} to be achieved`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evaluateMilestones does not require the age threshold for non-age milestones', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const store = await evaluateMilestones({
      ageDays: 3,
      proposalCount: 150,
      earnedUsdc: 0,
      deploymentCount: 0,
    })
    assert.ok(store.achieved['proposals-100'])
    assert.ok(store.achieved['age-7'] === undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ─── Timeline ─────────────────────────────────────────────────────────────

test('timelineFromStore marks achieved and pending milestones', () => {
  const store = {
    bornAt: Date.now() - 30 * DAY,
    achieved: {
      'age-7': { def: milestoneById('age-7')!, value: 7, achievedAt: 1 },
    },
  }
  const stats = { ageDays: 30, proposalCount: 5, earnedUsdc: 0, deploymentCount: 0 }
  const tl = timelineFromStore(store, stats)
  assert.equal(tl.achievedCount, 1)
  assert.equal(tl.totalCount, MILESTONE_DEFS.length)
  const age7 = tl.milestones.find((m) => m.def.id === 'age-7')
  assert.ok(age7 && age7.achieved)
  const age30 = tl.milestones.find((m) => m.def.id === 'age-30')
  assert.ok(age30 && !age30.achieved)
  assert.equal(age30.value, 30)
})

test('getMilestoneTimeline settles birthdate and reports app age', async () => {
  const dir = await tempDir()
  try {
    setMilestonesPath(join(dir, 'milestones.json'))
    const born = Date.now() - 31 * DAY
    const tl = await getMilestoneTimeline(
      { ageDays: 31, proposalCount: 0, earnedUsdc: 0, deploymentCount: 0 },
      born,
    )
    assert.equal(tl.bornAt, born)
    assert.equal(tl.ageDays, 31)
    assert.ok(tl.milestones.find((m) => m.def.id === 'age-30')?.achieved)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
