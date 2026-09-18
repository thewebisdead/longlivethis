import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseEconomicsStore,
  serializeEconomicsStore,
  setProposalEconomicsPath,
  getProposalEconomicsPath,
  recordActualEconomics,
  listActualEconomics,
  getActualEconomics,
  actualEconomicsCount,
} from './economics.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'proposal-economics-test-'))
  const store = join(d, 'proposal-economics.json')
  setProposalEconomicsPath(store)
  return d
}

function cleanup(d: string): void {
  try { rmSync(d, { recursive: true }) } catch { /* ignored */ }
}

test('setProposalEconomicsPath/getProposalEconomicsPath round-trip', () => {
  const orig = getProposalEconomicsPath()
  setProposalEconomicsPath('/tmp/test-proposal-economics.json')
  assert.equal(getProposalEconomicsPath(), '/tmp/test-proposal-economics.json')
  setProposalEconomicsPath(orig)
})

test('empty store returns no records by default', async () => {
  const d = tempDir()
  try {
    assert.deepEqual(await listActualEconomics(), [])
    assert.equal(await getActualEconomics(42), null)
  } finally {
    cleanup(d)
  }
})

test('recordActualEconomics stores a full outcome', async () => {
  const d = tempDir()
  try {
    const rec = await recordActualEconomics({
      proposalId: 7,
      actualCostUsdc: 15,
      actualRecurringCostUsdc: 2,
      actualBenefitUsdc: 30,
      note: 'measured after 30 days',
    })
    assert.equal(rec.proposalId, 7)
    assert.equal(rec.actualCostUsdc, 15)
    assert.equal(rec.actualRecurringCostUsdc, 2)
    assert.equal(rec.actualBenefitUsdc, 30)
    assert.equal(rec.note, 'measured after 30 days')

    const got = await getActualEconomics(7)
    assert.ok(got)
    assert.equal(got!.actualCostUsdc, 15)
  } finally {
    cleanup(d)
  }
})

test('recording replaces values (not cumulative)', async () => {
  const d = tempDir()
  try {
    await recordActualEconomics({ proposalId: 3, actualCostUsdc: 10 })
    await recordActualEconomics({ proposalId: 3, actualCostUsdc: 20, actualBenefitUsdc: 5.5 })
    const rec = await getActualEconomics(3)
    assert.ok(rec)
    assert.equal(rec!.actualCostUsdc, 20)
    assert.equal(rec!.actualBenefitUsdc, 5.5)
  } finally {
    cleanup(d)
  }
})

test('recordActualEconomics allows partial (cost-only) records', async () => {
  const d = tempDir()
  try {
    const rec = await recordActualEconomics({ proposalId: 9, actualCostUsdc: 4 })
    assert.equal(rec.actualCostUsdc, 4)
    assert.equal(rec.actualRecurringCostUsdc, null)
    assert.equal(rec.actualBenefitUsdc, null)
  } finally {
    cleanup(d)
  }
})

test('recordActualEconomics rejects bad input', async () => {
  const d = tempDir()
  try {
    await assert.rejects(() => recordActualEconomics({ proposalId: 0, actualCostUsdc: 1 }), /positive integer/)
    await assert.rejects(() => recordActualEconomics({ proposalId: 1, actualCostUsdc: -5 }), /non-negative/)
    await assert.rejects(() => recordActualEconomics({ proposalId: 1, actualBenefitUsdc: -1 }), /non-negative/)
  } finally {
    cleanup(d)
  }
})

test('actualEconomicsCount counts only records with a measured figure', () => {
  assert.equal(
    actualEconomicsCount([
      { proposalId: 1, actualCostUsdc: 5, actualRecurringCostUsdc: null, actualBenefitUsdc: null, updatedAt: 1 },
    ]),
    1
  )
  assert.equal(
    actualEconomicsCount([
      { proposalId: 2, actualCostUsdc: null, actualRecurringCostUsdc: null, actualBenefitUsdc: null, updatedAt: 2 },
    ]),
    0
  )
  assert.equal(actualEconomicsCount([]), 0)
})

test('listActualEconomics sorts most-recent-first', async () => {
  const d = tempDir()
  try {
    await recordActualEconomics({ proposalId: 1, actualCostUsdc: 1 })
    await new Promise((r) => setTimeout(r, 5))
    await recordActualEconomics({ proposalId: 2, actualCostUsdc: 2 })
    const all = await listActualEconomics()
    assert.equal(all[0].proposalId, 2)
    assert.equal(all[1].proposalId, 1)
  } finally {
    cleanup(d)
  }
})

test('round-trip serialize / parse', () => {
  const store = {
    records: [
      { proposalId: 1, actualCostUsdc: 5, actualRecurringCostUsdc: 1, actualBenefitUsdc: 8, updatedAt: 100, note: 'x' },
      { proposalId: 2, actualCostUsdc: null, actualRecurringCostUsdc: null, actualBenefitUsdc: 7.5, updatedAt: 200 },
    ],
  }
  const parsed = parseEconomicsStore(serializeEconomicsStore(store))
  assert.deepEqual(parsed, store)
})

test('parseEconomicsStore rejects malformed data', () => {
  assert.throws(() => parseEconomicsStore('not json'), /JSON/)
  assert.throws(() => parseEconomicsStore('{}'), /no records array/)
})
