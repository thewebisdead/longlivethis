import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KONAMI, feedKonami } from './konami.ts'

test('KONAMI is the classic code', () => {
  assert.deepEqual(KONAMI, [
    'ArrowUp',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowLeft',
    'ArrowRight',
    'b',
    'a',
  ])
})

test('feedKonami completes only on the final key and resets', () => {
  const state: string[] = []
  for (const key of KONAMI.slice(0, -1)) {
    assert.equal(feedKonami(state, key), false)
  }
  assert.equal(feedKonami(state, 'a'), true)
  // After completion the state is cleared — a fresh code can start again.
  assert.equal(state.length, 0)
})

test('feedKonami tolerates unrelated keys that scroll out of the window', () => {
  // A rolling window of the last 10 keys: unrelated keys before the code are
  // trimmed away, so a stray Shift/typo never breaks the intended code.
  const state: string[] = []
  // `Shift` + the full 10-key code = 11 keys → the leading Shift is trimmed.
  const keys = ['Shift', ...KONAMI]
  let complete = false
  for (const key of keys) {
    if (feedKonami(state, key)) complete = true
  }
  assert.equal(complete, true)
})

test('feedKonami can restart a fresh code after a wrong one', () => {
  const state: string[] = []
  // A nearly-correct but wrong sequence.
  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
    feedKonami(state, key)
  }
  assert.equal(state.join() === KONAMI.join(), false)
  // Now the full correct code still triggers.
  let complete = false
  for (const key of KONAMI) {
    if (feedKonami(state, key)) complete = true
  }
  assert.equal(complete, true)
})

test('feedKonami normalises Shift+letter to the lowercase code char', () => {
  const state: string[] = []
  const keys = [...KONAMI.slice(0, 8), 'B', 'A'] // Shift held for b & a
  let complete = false
  for (const key of keys) {
    if (feedKonami(state, key)) complete = true
  }
  assert.equal(complete, true)
})
