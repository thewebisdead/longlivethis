import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRunFile } from './runs.ts'

test('parseRunFile reads metadata + event lines into a Run', () => {
  const raw = [
    JSON.stringify({
      _run: { id: 'abc123', proposal: 'Add a /runs page', model: 'x', outcome: 'committed', cost: '$0.50', startedAt: '2026-08-12T03:00:00Z' },
    }),
    JSON.stringify({ type: 'step_start', step: '1', timestamp: '2026-08-12T03:00:01Z', proposal: 'Add a /runs page' }),
    JSON.stringify({ type: 'text', text: 'Investigating the event schema.' }),
    JSON.stringify({ type: 'tool_use', tool: 'read', input: { path: 'app/src/lib/runs.ts' }, resultSummary: '{ "file": "…" }' }),
    JSON.stringify({ type: 'step_finish', outcome: 'committed', cost: '$0.50' }),
  ].join('\n')

  const run = parseRunFile('runs/abc123.jsonl', raw)
  assert.equal(run.id, 'abc123')
  assert.equal(run.proposal, 'Add a /runs page')
  assert.equal(run.model, 'x')
  assert.equal(run.outcome, 'committed')
  assert.equal(run.cost, '$0.50')
  assert.equal(run.startedAt, '2026-08-12T03:00:00Z')
  assert.equal(run.events.length, 4)
  assert.equal(run.events[0].type, 'step_start')
  assert.equal(run.events[2].type, 'tool_use')
  assert.equal((run.events[2] as { tool?: string }).tool, 'read')
})

test('parseRunFile tolerates garbage lines without dropping the rest', () => {
  const raw = ['not json', '{', JSON.stringify({ type: 'text', text: 'hello' })].join('\n')
  const run = parseRunFile('runs/broken.jsonl', raw)
  assert.equal(run.events.length, 1)
  assert.equal(run.events[0].type, 'text')
})

test('parseRunFile derives fields from events when no metadata line exists', () => {
  const raw = [
    JSON.stringify({ type: 'step_start', step: '1', model: 'm1', timestamp: '2026-01-01T00:00:00Z', proposal: 'Derived title' }),
    JSON.stringify({ type: 'text', text: 'work' }),
    JSON.stringify({ type: 'step_finish', outcome: 'failed', cost: '$0.01' }),
  ].join('\n')
  const run = parseRunFile('runs/x.jsonl', raw)
  assert.equal(run.proposal, 'Derived title')
  assert.equal(run.model, 'm1')
  assert.equal(run.outcome, 'failed')
  assert.equal(run.cost, '$0.01')
  assert.equal(run.startedAt, '2026-01-01T00:00:00Z')
})

test('parseRunFile falls back to the path when nothing identifies the run', () => {
  const run = parseRunFile('runs/zz.jsonl', '{"type":"text","text":"hi"}')
  assert.equal(run.proposal, 'runs/zz.jsonl')
  assert.equal(run.model, '')
  assert.equal(run.outcome, '')
})
