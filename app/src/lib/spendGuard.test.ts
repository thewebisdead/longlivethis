import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRun, modeForLevel } from './spendGuard.ts'
import type { RunMode } from './spendGuard.ts'

function runway(level: 'safe' | 'reduced' | 'critical' | 'paused', days: number) {
  return { level, runwayDays: days }
}

test('modeForLevel maps runway levels to run modes', () => {
  assert.equal(modeForLevel('safe'), 'run')
  assert.equal(modeForLevel('reduced'), 'run')
  assert.equal(modeForLevel('critical'), 'downshift')
  assert.equal(modeForLevel('paused'), 'skip')
})

test('decideRun runs normally on a safe runway', () => {
  const d = decideRun(runway('safe', 90))
  assert.equal(d.mode, 'run')
  assert.equal(d.level, 'safe')
  assert.equal(d.runwayDays, 90)
})

test('decideRun runs normally on a reduced runway', () => {
  const d = decideRun(runway('reduced', 15))
  assert.equal(d.mode, 'run')
})

test('decideRun downshifts on a critical runway', () => {
  const d = decideRun(runway('critical', 5))
  assert.equal(d.mode, 'downshift')
  assert.match(d.reason, /critical/)
  assert.match(d.reason, /downshifting/)
})

test('decideRun can override a downshift to run (operator escape hatch)', () => {
  const d = decideRun(runway('critical', 5), { allowDownshift: true })
  assert.equal(d.mode, 'run')
  assert.match(d.reason, /overridden/)
})

test('decideRun skips on a paused runway', () => {
  const d = decideRun(runway('paused', 2))
  assert.equal(d.mode, 'skip')
  assert.match(d.reason, /paused/)
  assert.match(d.reason, /skipping/)
})

test('decideRun can override a skip down to downshift (never to run past paused)', () => {
  const d = decideRun(runway('paused', 2), { allowSkip: true })
  assert.equal(d.mode, 'downshift') // still not a full run — downshift is the ceiling
  assert.match(d.reason, /overridden/)
})

test('decideRun defaults are conservative: no overrides mean skip/downshift are obeyed', () => {
  // No opts passed → a paused runway is still skipped, critical still downshifted.
  assert.equal(decideRun(runway('paused', 2)).mode, 'skip')
  assert.equal(decideRun(runway('critical', 5)).mode, 'downshift')
})

const modes: RunMode[] = ['run', 'downshift', 'skip']
test('every decision object carries the full shape', () => {
  for (const level of ['safe', 'reduced', 'critical', 'paused'] as const) {
    const d = decideRun(runway(level, 10))
    assert.ok(modes.includes(d.mode))
    assert.equal(typeof d.reason, 'string')
    assert.equal(d.level, level)
    assert.equal(typeof d.runwayDays, 'number')
  }
})
