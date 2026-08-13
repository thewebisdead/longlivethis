import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLog, summarize } from './runs.ts'

test('parseLog extracts the JSONL event stream out of a raw workflow log', () => {
  const log = [
    '2026-08-12T03:00:00.0000000Z === 2026-08-12T03:00:00Z select-proposal start ===',
    '2026-08-12T03:00:01.0000000Z Proposals: 3 open, 1 eligible after the vote + claim screen.',
    JSON.stringify({ type: 'step_start', step: 'implement', model: 'moonshotai/kimi-k3', proposal: 'Add a /runs page' }),
    'some random shell output {not json}',
    JSON.stringify({ type: 'text', text: 'Investigating the event schema.' }),
    JSON.stringify({ type: 'tool_use', tool: 'read', input: { path: 'app/src/lib/runs.ts' }, resultSummary: '{ "file": "…" }' }),
    JSON.stringify({ type: 'step_finish', outcome: 'committed', cost: '$0.50' }),
    '',
  ].join('\n')

  const events = parseLog(log)
  assert.equal(events.length, 4)
  assert.equal(events[0].type, 'step_start')
  assert.equal(events[0].model, 'moonshotai/kimi-k3')
  assert.equal(events[1].type, 'text')
  assert.equal(events[2].type, 'tool_use')
  assert.equal(events[2].tool, 'read')
  assert.equal(events[3].type, 'step_finish')
})

test('parseLog lifts a nested part payload onto the event', () => {
  const events = parseLog(
    JSON.stringify({ type: 'text', timestamp: 1, part: { type: 'text', text: 'hello from part' } })
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].text, 'hello from part')
})

test('parseLog ignores non-event lines and JSON objects without a type', () => {
  const log = [
    'not json at all',
    '{"level":"info","msg":"plain log object"}',
    '[1,2,3]',
    JSON.stringify({ type: 'error', error: 'boom' }),
  ].join('\n')
  const events = parseLog(log)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
})

test('summarize builds the Run from workflow-run fields plus the stream', () => {
  const events = parseLog(
    [
      JSON.stringify({ type: 'step_start', model: 'm1', proposal: 'Fix the runs page' }),
      JSON.stringify({ type: 'step_finish', cost: '$0.42' }),
    ].join('\n')
  )
  const run = summarize(
    {
      id: 12345,
      name: 'agent',
      event: 'schedule',
      conclusion: 'success',
      created_at: '2026-08-12T03:00:00Z',
      head_branch: 'feat/fix-the-runs-page',
    },
    events
  )
  assert.equal(run.id, '12345')
  assert.equal(run.proposal, 'Fix the runs page')
  assert.equal(run.model, 'm1')
  assert.equal(run.outcome, 'success')
  assert.equal(run.cost, '$0.42')
  assert.equal(run.startedAt, '2026-08-12T03:00:00Z')
  assert.equal(run.events.length, 2)
})

test('summarize falls back to the branch when the stream names no proposal', () => {
  const run = summarize(
    {
      id: 7,
      conclusion: 'failure',
      created_at: '2026-01-01T00:00:00Z',
      head_branch: 'feat/dark-mode-toggle',
    },
    parseLog(JSON.stringify({ type: 'text', text: 'work' }))
  )
  assert.equal(run.proposal, 'dark mode toggle')
  assert.equal(run.outcome, 'failure')
  assert.equal(run.model, '')
  assert.equal(run.cost, '')
})
