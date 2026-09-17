import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  emptyStore,
  parseRevenueStore,
  serializeRevenueStore,
  validateRevenueProposal,
  setRevenueStorePath,
  listRevenueProposals,
  getRevenueProposal,
  createRevenueProposal,
  setRevenueStatus,
  revenueSummary,
  SEED_REVENUE_PROPOSALS,
} from './revenue.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'revenue-test-'))
  const store = join(d, 'revenue-proposals.json')
  setRevenueStorePath(store)
  return d
}

function cleanup(d: string): void {
  try { rmSync(d, { recursive: true }) } catch { /* ignored */ }
}

test('emptyStore returns seeded proposals', () => {
  const store = emptyStore()
  assert.ok(Array.isArray(store.proposals))
  assert.equal(store.proposals.length, SEED_REVENUE_PROPOSALS.length)
  assert.equal(store.nextId, SEED_REVENUE_PROPOSALS.length + 1)
  for (const p of store.proposals) {
    assert.equal(p.status, 'open')
    assert.ok(p.id > 0)
    assert.ok(p.createdAt > 0)
    assert.ok(p.updatedAt > 0)
    assert.equal(p.createdAt, p.updatedAt)
  }
})

test('first boot seeds the funding menu', async () => {
  const d = tempDir()
  try {
    const got = await listRevenueProposals()
    assert.equal(got.length, SEED_REVENUE_PROPOSALS.length)
    // Most recent first — reverse of seed order
    assert.equal(got[0].title, SEED_REVENUE_PROPOSALS[SEED_REVENUE_PROPOSALS.length - 1].title)
    assert.equal(got[got.length - 1].title, SEED_REVENUE_PROPOSALS[0].title)
  } finally {
    cleanup(d)
  }
})

test('getRevenueProposal returns null for missing id', async () => {
  const d = tempDir()
  try {
    const p = await getRevenueProposal(9999)
    assert.equal(p, null)
  } finally {
    cleanup(d)
  }
})

test('createRevenueProposal adds a proposal', async () => {
  const d = tempDir()
  try {
    const created = await createRevenueProposal({
      type: 'other',
      title: 'Fund the coffee fund',
      description: 'Keep the agent caffeinated.',
      targetUsdc: 5,
    })
    assert.ok(created.id > 0)
    assert.equal(created.title, 'Fund the coffee fund')
    assert.equal(created.status, 'open')
    assert.equal(created.targetUsdc, 5)
    assert.equal(created.minUsdc, 1) // default when not specified

    // Should be at the top of the list
    const all = await listRevenueProposals()
    assert.equal(all[0].id, created.id)
  } finally {
    cleanup(d)
  }
})

test('setRevenueStatus transitions state', async () => {
  const d = tempDir()
  try {
    const created = await createRevenueProposal({
      type: 'badge',
      title: 'Test badge',
      description: 'A test',
      targetUsdc: 10,
      minUsdc: 3,
    })
    const claimed = await setRevenueStatus(created.id, 'claimed')
    assert.ok(claimed)
    assert.equal(claimed!.status, 'claimed')
    assert.ok(claimed!.updatedAt > claimed!.createdAt)

    const funded = await setRevenueStatus(created.id, 'funded')
    assert.ok(funded)
    assert.equal(funded!.status, 'funded')
  } finally {
    cleanup(d)
  }
})

test('setRevenueStatus returns null for missing id', async () => {
  const d = tempDir()
  try {
    const r = await setRevenueStatus(9999, 'funded')
    assert.equal(r, null)
  } finally {
    cleanup(d)
  }
})

test('validateRevenueProposal rejects bad input', () => {
  assert.throws(() => validateRevenueProposal({ type: 'bad' as never, title: 'test', description: 'test', targetUsdc: 1 }),
    /unknown revenue type/)
  assert.throws(() => validateRevenueProposal({ type: 'api', title: '', description: 'test', targetUsdc: 1 }),
    /title required/)
  assert.throws(() => validateRevenueProposal({ type: 'api', title: 'test', description: '', targetUsdc: 1 }),
    /description required/)
  assert.throws(() => validateRevenueProposal({ type: 'api', title: 'test', description: 'test', targetUsdc: 0 }),
    /targetUsdc must be positive/)
  assert.throws(() => validateRevenueProposal({ type: 'api', title: 'test', description: 'test', targetUsdc: 10, minUsdc: 20 }),
    /minUsdc cannot exceed targetUsdc/)
})

test('validateRevenueProposal accepts valid input', () => {
  const v = validateRevenueProposal({
    type: 'sponsorship',
    title: 'Hello',
    description: 'World',
    targetUsdc: 50,
    minUsdc: 10,
  })
  assert.equal(v.type, 'sponsorship')
  assert.equal(v.title, 'Hello')
  assert.equal(v.targetUsdc, 50)
  assert.equal(v.minUsdc, 10)
})

test('revenueSummary computes correct totals', () => {
  const proposals = emptyStore().proposals
  const s = revenueSummary(proposals)
  assert.equal(s.openCount, SEED_REVENUE_PROPOSALS.length)
  assert.equal(s.fundedCount, 0)
  assert.equal(s.totalTargetUsdc, SEED_REVENUE_PROPOSALS.reduce((sum, p) => sum + p.targetUsdc, 0))
  assert.equal(s.openCount + s.fundedCount, SEED_REVENUE_PROPOSALS.length)
})

test('revenueSummary with mix of statuses', () => {
  const now = Date.now()
  const proposals = [
    {
      id: 1, type: 'sponsorship' as const, title: 'A', description: 'D',
      targetUsdc: 100, minUsdc: 10, status: 'open' as const,
      createdAt: now, updatedAt: now,
    },
    {
      id: 2, type: 'badge' as const, title: 'B', description: 'D',
      targetUsdc: 50, minUsdc: 5, status: 'funded' as const,
      createdAt: now, updatedAt: now,
    },
    {
      id: 3, type: 'api' as const, title: 'C', description: 'D',
      targetUsdc: 30, minUsdc: 5, status: 'claimed' as const,
      createdAt: now, updatedAt: now,
    },
  ]
  const s = revenueSummary(proposals)
  assert.equal(s.totalTargetUsdc, 180)
  assert.equal(s.fundedCount, 1)
  assert.equal(s.openCount, 2)
  assert.equal(s.openTargetUsdc, 130) // 100 (open) + 30 (claimed) — claimed counts as open funding target
})

test('parseRevenueStore handles empty input', () => {
  const store = parseRevenueStore('')
  assert.equal(store.proposals.length, SEED_REVENUE_PROPOSALS.length)
})

test('parseRevenueStore rejects malformed data', () => {
  assert.throws(() => parseRevenueStore('not json'), /JSON/)
  assert.throws(() => parseRevenueStore('{}'), /no proposals array/)
})

test('round-trip serialize / parse', () => {
  const store = emptyStore()
  // Mark one as funded
  store.proposals[0].status = 'funded'
  store.proposals[0].updatedAt = Date.now() + 1000
  const serialized = serializeRevenueStore(store)
  const parsed = parseRevenueStore(serialized)
  assert.equal(parsed.proposals.length, store.proposals.length)
  assert.equal(parsed.nextId, store.nextId)
  const p = parsed.proposals[0]
  assert.equal(p.status, 'funded')
  assert.equal(p.updatedAt, store.proposals[0].updatedAt)
})

test('persists data after write', async () => {
  const d = tempDir()
  try {
    const created = await createRevenueProposal({
      type: 'marketplace',
      title: 'Persist test',
      description: 'Should survive re-read',
      targetUsdc: 25,
      minUsdc: 5,
    })
    const p1 = await getRevenueProposal(created.id)
    assert.ok(p1)
    assert.equal(p1!.title, 'Persist test')

    // Read the raw file
    const path = join(d, 'revenue-proposals.json')
    const raw = readFileSync(path, 'utf8')
    assert.ok(raw.includes('Persist test'))

    // Re-read through the API
    const all = await listRevenueProposals()
    assert.ok(all.some(p => p.title === 'Persist test'))
  } finally {
    cleanup(d)
  }
})
