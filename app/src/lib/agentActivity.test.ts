import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseAgentActivity,
  serializeAgentActivity,
  recordAgentActivity,
  readAgentActivity,
  agentActivityView,
  setAgentActivityPath,
  getAgentActivityPath,
  MAX_ACTIVITY_ENTRIES,
} from './agentActivity.ts'
import type { AgentActivityEntry } from './agentActivity.ts'

// Isolate each test's activity file.
function useTempPath(): string {
  const p = join(tmpdir(), `agent-activity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  setAgentActivityPath(p)
  return p
}

async function cleanup(path: string): Promise<void> {
  await unlink(path).catch(() => null)
}

function sampleEntry(over: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    ts: 1000,
    mode: 'run',
    reason: 'runway is safe — safe to run the agent',
    level: 'safe',
    runwayDays: 60,
    survivalLevel: 'normal',
    throttled: false,
    dispatched: true,
    runId: 'run-1',
    error: null,
    proposals: ['Add a dark mode', 'Fix the homepage'],
    ...over,
  }
}

// ─── Serialization ────────────────────────────────────────────────────────

test('parseAgentActivity returns empty for empty input', () => {
  assert.deepEqual(parseAgentActivity(''), { entries: [] })
})

test('state round-trips through serialize/parse', () => {
  const state = { entries: [sampleEntry(), sampleEntry({ mode: 'skip', dispatched: false, runId: null, error: 'runway paused' })] }
  const parsed = parseAgentActivity(serializeAgentActivity(state))
  assert.deepEqual(parsed, state)
})

test('parseAgentActivity skips malformed entries gracefully', () => {
  const parsed = parseAgentActivity('{"entries":[{"ts":"nope"},{"ts":1,"mode":"run","reason":"ok"}]}')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].ts, 1)
  assert.equal(parsed.entries[0].mode, 'run')
})

test('parseAgentActivity tolerates missing optional fields', () => {
  const parsed = parseAgentActivity('{"entries":[{"ts":1,"mode":"skip","reason":"no"}]}')
  assert.equal(parsed.entries[0].runwayDays, 0)
  assert.equal(parsed.entries[0].survivalLevel, 'normal')
  assert.equal(parsed.entries[0].dispatched, false)
  assert.deepEqual(parsed.entries[0].proposals, [])
})

// ─── Config round-trip ────────────────────────────────────────────────────

test('setAgentActivityPath/getAgentActivityPath round-trip', () => {
  const orig = getAgentActivityPath()
  setAgentActivityPath('/tmp/test-agent-activity.json')
  assert.equal(getAgentActivityPath(), '/tmp/test-agent-activity.json')
  setAgentActivityPath(orig)
})

// ─── Record + read ────────────────────────────────────────────────────────

test('recordAgentActivity appends and persists, view returns newest first', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  await recordAgentActivity(sampleEntry({ ts: 1000, runId: 'run-1' }))
  await recordAgentActivity(sampleEntry({ ts: 2000, runId: 'run-2' }))

  const viewed = await agentActivityView()
  assert.equal(viewed.total, 2)
  assert.equal(viewed.entries[0].runId, 'run-2') // newest first
  assert.equal(viewed.entries[1].runId, 'run-1')

  // Persisted on disk.
  const state = await readAgentActivity()
  assert.equal(state.entries.length, 2)
  await cleanup(path)
})

test('recordAgentActivity prunes old entries past the cap', async () => {
  const path = useTempPath()
  await mkdir(tmpdir(), { recursive: true })
  for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 25; i++) {
    await recordAgentActivity(sampleEntry({ ts: i, runId: `run-${i}` }))
  }
  const state = await readAgentActivity()
  assert.equal(state.entries.length, MAX_ACTIVITY_ENTRIES)
  // Newest retained, oldest pruned.
  assert.equal(state.entries[state.entries.length - 1].runId, `run-${MAX_ACTIVITY_ENTRIES + 24}`)
  assert.equal(state.entries[0].runId, 'run-25')
  await cleanup(path)
})
