import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseProposalRevenueStore,
  serializeProposalRevenueStore,
  setProposalRevenuePath,
  getProposalRevenuePath,
  recordProposalRevenue,
  listProposalRevenue,
  getProposalRevenue,
  totalAttributedRevenue,
} from './revenueProposal.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'proposal-revenue-test-'))
  const store = join(d, 'proposal-revenue.json')
  setProposalRevenuePath(store)
  return d
}

function cleanup(d: string): void {
  try { rmSync(d, { recursive: true }) } catch { /* ignored */ }
}

test('setProposalRevenuePath/getProposalRevenuePath round-trip', () => {
  const orig = getProposalRevenuePath()
  setProposalRevenuePath('/tmp/test-proposal-revenue.json')
  assert.equal(getProposalRevenuePath(), '/tmp/test-proposal-revenue.json')
  setProposalRevenuePath(orig)
})

test('empty store returns no records by default', async () => {
  const d = tempDir()
  try {
    const all = await listProposalRevenue()
    assert.deepEqual(all, [])
    const one = await getProposalRevenue(42)
    assert.equal(one, null)
  } finally {
    cleanup(d)
  }
})

test('recordProposalRevenue adds a record', async () => {
  const d = tempDir()
  try {
    const rec = await recordProposalRevenue({ proposalId: 7, amountUsdc: 25, note: 'sponsor' })
    assert.equal(rec.proposalId, 7)
    assert.equal(rec.amountUsdc, 25)
    assert.equal(rec.note, 'sponsor')
    assert.ok(rec.updatedAt > 0)

    const got = await getProposalRevenue(7)
    assert.ok(got)
    assert.equal(got!.amountUsdc, 25)
  } finally {
    cleanup(d)
  }
})

test('recordProposalRevenue accumulates across calls', async () => {
  const d = tempDir()
  try {
    await recordProposalRevenue({ proposalId: 3, amountUsdc: 10 })
    await recordProposalRevenue({ proposalId: 3, amountUsdc: 5.5 })
    const rec = await getProposalRevenue(3)
    assert.ok(rec)
    assert.equal(rec!.amountUsdc, 15.5)
  } finally {
    cleanup(d)
  }
})

test('recordProposalRevenue rejects bad input', async () => {
  const d = tempDir()
  try {
    await assert.rejects(() => recordProposalRevenue({ proposalId: 0, amountUsdc: 10 }), /positive integer/)
    await assert.rejects(() => recordProposalRevenue({ proposalId: 1, amountUsdc: -5 }), /positive/)
  } finally {
    cleanup(d)
  }
})

test('totalAttributedRevenue sums records', () => {
  const records = [
    { proposalId: 1, amountUsdc: 10, updatedAt: 1 },
    { proposalId: 2, amountUsdc: 20, updatedAt: 2 },
    { proposalId: 3, amountUsdc: 0.5, updatedAt: 3 },
  ]
  assert.equal(totalAttributedRevenue(records), 30.5)
  assert.equal(totalAttributedRevenue([]), 0)
})

test('listProposalRevenue sorts most-recent-first', async () => {
  const d = tempDir()
  try {
    await recordProposalRevenue({ proposalId: 1, amountUsdc: 1 })
    // Force a later timestamp by another write.
    await new Promise((r) => setTimeout(r, 5))
    await recordProposalRevenue({ proposalId: 2, amountUsdc: 2 })
    const all = await listProposalRevenue()
    assert.equal(all[0].proposalId, 2)
    assert.equal(all[1].proposalId, 1)
  } finally {
    cleanup(d)
  }
})

test('round-trip serialize / parse', () => {
  const store = {
    records: [
      { proposalId: 1, amountUsdc: 5, updatedAt: 100, note: 'x' },
      { proposalId: 2, amountUsdc: 7.5, updatedAt: 200 },
    ],
  }
  const parsed = parseProposalRevenueStore(serializeProposalRevenueStore(store))
  assert.deepEqual(parsed, store)
})

test('parseProposalRevenueStore rejects malformed data', () => {
  assert.throws(() => parseProposalRevenueStore('not json'), /JSON/)
  assert.throws(() => parseProposalRevenueStore('{}'), /no records array/)
})
