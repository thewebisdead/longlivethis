import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseTriggerState,
  serializeTriggerState,
  EMPTY_TRIGGER_STATE,
  setAgentTriggerPath,
  getAgentTriggerPath,
  DEFAULT_CADENCE_MS,
} from './agentTrigger.ts'
import type { TriggerState } from './agentTrigger.ts'

test('parseTriggerState returns empty state for empty string', () => {
  assert.deepEqual(parseTriggerState(''), EMPTY_TRIGGER_STATE)
  assert.deepEqual(parseTriggerState('  '), EMPTY_TRIGGER_STATE)
})

test('parseTriggerState parses a valid state', () => {
  const state: TriggerState = {
    lastAttemptTs: 1000,
    lastDispatchTs: 1001,
    lastMode: 'run',
    lastRunId: 'run-abc',
    lastRunwayDays: 50,
    lastReason: 'safe to run',
  }
  const parsed = parseTriggerState(serializeTriggerState(state))
  assert.deepEqual(parsed, state)
})

test('parseTriggerState tolerates partial / missing fields', () => {
  const parsed = parseTriggerState('{}')
  assert.equal(parsed.lastAttemptTs, null)
  assert.equal(parsed.lastMode, null)
})

test('parseTriggerState rejects invalid mode values gracefully', () => {
  const parsed = parseTriggerState('{"lastMode":"invalid"}')
  assert.equal(parsed.lastMode, null)
})

test('state round-trips through serialize/parse', () => {
  const states: TriggerState[] = [
    EMPTY_TRIGGER_STATE,
    { lastAttemptTs: 100, lastDispatchTs: null, lastMode: null, lastRunId: null, lastRunwayDays: null, lastReason: null },
    { lastAttemptTs: 200, lastDispatchTs: 201, lastMode: 'skip', lastRunId: 'run-xyz', lastRunwayDays: 2, lastReason: 'paused' },
    { lastAttemptTs: 300, lastDispatchTs: 301, lastMode: 'downshift', lastRunId: null, lastRunwayDays: 5.5, lastReason: 'critical' },
  ]
  for (const s of states) {
    const parsed = parseTriggerState(serializeTriggerState(s))
    assert.deepEqual(parsed, s)
  }
})

test('setAgentTriggerPath/getAgentTriggerPath round-trip', () => {
  const orig = getAgentTriggerPath()
  setAgentTriggerPath('/tmp/test-trigger.json')
  assert.equal(getAgentTriggerPath(), '/tmp/test-trigger.json')
  setAgentTriggerPath(orig) // restore
})

test('DEFAULT_CADENCE_MS is one hour', () => {
  assert.equal(DEFAULT_CADENCE_MS, 60 * 60 * 1000)
})
