import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newGame, step } from './runner.ts'

test('newGame creates a valid initial state', () => {
  const g = newGame()
  assert.equal(g.lane, 1)
  assert.equal(g.alive, true)
  assert.equal(g.collided, false)
  assert.equal(g.speed, 6)
  assert(g.tiles.length > 0)
})

test('stepping advances distance and score', () => {
  const g = newGame()
  step(g, 1, {})
  assert(g.distance > 0)
  assert(g.score > 0)
})

test('input left moves lane left', () => {
  const g = newGame()
  g.lane = 1
  step(g, 0.016, { left: true })
  assert.equal(g.lane, 0)
})

test('input right moves lane right', () => {
  const g = newGame()
  g.lane = 1
  step(g, 0.016, { right: true })
  assert.equal(g.lane, 2)
})

test('input left at lane 0 does nothing', () => {
  const g = newGame()
  g.lane = 0
  step(g, 0.016, { left: true })
  assert.equal(g.lane, 0)
})

test('input right at lane 2 does nothing', () => {
  const g = newGame()
  g.lane = 2
  step(g, 0.016, { right: true })
  assert.equal(g.lane, 2)
})

test('jump launches the player upward', () => {
  const g = newGame()
  step(g, 0.016, { jump: true })
  assert(g.height > 0)
})

test('gravity brings player back down', () => {
  const g = newGame()
  step(g, 0.016, { jump: true })
  // Fast-forward enough frames to land
  let grounded = false
  for (let i = 0; i < 120; i++) {
    step(g, 0.016, {})
    if (g.height <= 0 && g.velY === 0) { grounded = true; break }
  }
  assert(grounded, 'Player should have landed after 120 frames')
})

test('speed increases over time', () => {
  const g = newGame()
  const initial = g.speed
  for (let i = 0; i < 100; i++) step(g, 0.016, {})
  assert(g.speed > initial)
})

test('collision kills the player', () => {
  // Create a game and force a collision scenario: place a train in front.
  const g = newGame()
  // Clear and add a train right in front
  g.tiles = [{ id: 999, lane: 1, z: 0.2, kind: 'train', length: 4, coins: 0, passed: false }]
  g.lane = 1
  step(g, 0.05, {}) // Move the train closer
  // After enough steps it should hit
  if (g.alive) {
    step(g, 0.05, {})
  }
  if (g.alive) {
    step(g, 0.05, {})
  }
  assert(g.collided || !g.alive, 'Should have collided with the train')
})
