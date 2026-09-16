import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseLedger,
  serializeLedger,
  setLedgerPath,
  getLedgerPath,
  readLedger,
  writeLedger,
  recordRunCost,
  recordBalance,
  summarize,
  EMPTY_STATE,
} from './ledger.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ledger-test-'))
}

test('ledger round-trips through serialize/parse', () => {
  const state = {
    entries: [
      { type: 'run', ts: 1000, runId: 'abc', inferenceCostUsdc: 0.5, hostingCostUsdc: 0.2, totalCostUsdc: 0.7 },
      { type: 'transfer', ts: 2000, amountUsdc: 5, balanceAfterUsdc: 50 },
    ],
    lastBalanceUsdc: 50,
  }
  const parsed = parseLedger(serializeLedger(state))
  assert.deepEqual(parsed, state)
})

test('parseLedger returns empty state for empty input', () => {
  assert.deepEqual(parseLedger(''), EMPTY_STATE)
})

test('parseLedger rejects malformed data', () => {
  assert.throws(() => parseLedger('not json'), SyntaxError)
  assert.throws(() => parseLedger('{}'), /no entries array/)
  assert.throws(() => parseLedger('{"entries":[{"type":"bogus"}]}'), /unknown ledger entry type/)
  assert.throws(() => parseLedger('{"entries":[{"type":"run","ts":"x"}]}'), /invalid run ledger entry/)
})

test('readLedger tolerates a missing file (first boot)', async () => {
  const dir = await tempDir()
  try {
    setLedgerPath(join(dir, 'ledger.json'))
    assert.deepEqual(await readLedger(), EMPTY_STATE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readLedger returns empty on a corrupt file rather than crashing', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'ledger.json')
    setLedgerPath(path)
    await writeFile(path, 'this is not json', 'utf8')
    assert.deepEqual(await readLedger(), EMPTY_STATE)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeLedger persists and readLedger retrieves', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, 'ledger.json')
    setLedgerPath(path)
    const state = {
      entries: [{ type: 'run', ts: 1, runId: 'r', inferenceCostUsdc: 1, hostingCostUsdc: 0.2, totalCostUsdc: 1.2 }],
      lastBalanceUsdc: 12,
    }
    await writeLedger(state)
    assert.deepEqual(await readLedger(), state)
    assert.equal(getLedgerPath(), path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordRunCost appends an entry (append-only, no pruning)', async () => {
  const dir = await tempDir()
  try {
    setLedgerPath(join(dir, 'ledger.json'))
    await recordRunCost(0.5, 0.2, 'run-1')
    await recordRunCost(0.3, 0.1, 'run-2')
    const state = await readLedger()
    assert.equal(state.entries.length, 2)
    const [a, b] = state.entries
    assert.equal(a.type, 'run')
    if (a.type === 'run') {
      assert.equal(a.runId, 'run-1')
      assert.equal(a.totalCostUsdc, 0.7)
    }
    if (b.type === 'run') assert.equal(b.runId, 'run-2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordBalance records a transfer on a rise and updates the baseline', async () => {
  const dir = await tempDir()
  try {
    setLedgerPath(join(dir, 'ledger.json'))
    // First observation: baseline only, no transfer recorded.
    assert.equal(await recordBalance(10), null)
    // A rise records a transfer.
    assert.equal(await recordBalance(25), 15)
    // Flat balance records nothing.
    assert.equal(await recordBalance(25), null)
    // A further rise records the delta from the last baseline.
    assert.equal(await recordBalance(30), 5)

    const state = await readLedger()
    assert.equal(state.lastBalanceUsdc, 30)
    assert.equal(state.entries.length, 2)
    const t = state.entries[1]
    assert.equal(t.type, 'transfer')
    if (t.type === 'transfer') {
      assert.equal(t.amountUsdc, 5)
      assert.equal(t.balanceAfterUsdc, 30)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordBalance updates the baseline on a drop (spend) without recording', async () => {
  const dir = await tempDir()
  try {
    setLedgerPath(join(dir, 'ledger.json'))
    await recordBalance(50)
    assert.equal(await recordBalance(40), null)
    // The drop reset the baseline, so the next rise is measured from 40.
    assert.equal(await recordBalance(55), 15)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('summarize totals run cost and transfers', () => {
  const state = {
    entries: [
      { type: 'run', ts: 1, runId: 'a', inferenceCostUsdc: 1, hostingCostUsdc: 0.2, totalCostUsdc: 1.2 },
      { type: 'run', ts: 2, runId: 'b', inferenceCostUsdc: 2, hostingCostUsdc: 0.2, totalCostUsdc: 2.2 },
      { type: 'transfer', ts: 3, amountUsdc: 10, balanceAfterUsdc: 20 },
    ],
    lastBalanceUsdc: 20,
  }
  const view = summarize(state)
  assert.equal(view.totalRunCostUsdc, 3.4)
  assert.equal(view.totalTransferredUsdc, 10)
  assert.equal(view.balanceUsdc, 20)
})
