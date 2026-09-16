import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newGame, seed, step, SAFE_ZONE, MAX_SPEED, ACCEL, START_SPEED } from './runner.ts'

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

test('seeding keeps the near track winnable: no non-coin tile in lane 1 before the safe zone', () => {
  for (let i = 0; i < 200; i++) {
    const g = newGame()
    // Player starts in lane 1; before the safe zone there must be no blocking
    // tile (train/barrier/gap) in lane 1 and no obstacle at all too close to
    // the player.
    for (const t of g.tiles) {
      if (t.kind === 'coin') continue
      assert(t.z >= SAFE_ZONE, `obstacle at z=${t.z} is inside the safe zone`)
      if (t.z < 10) {
        assert.notEqual(t.lane, 1, `obstacle in lane 1 at z=${t.z} before safe zone`)
      }
    }
  }
})

test('a fresh run with no input survives at least 3 seconds', () => {
  let survived = false
  for (let i = 0; i < 100; i++) {
    const g = newGame()
    // Simulate 3 seconds at 0.016 steps with no input.
    for (let t = 0; t < 3 / 0.016; t++) {
      step(g, 0.016, {})
      if (!g.alive) break
    }
    if (g.alive) { survived = true; break }
  }
  assert(survived, 'No fresh game survived 3 seconds with no input')
})

test('collected coin points persist in the score', () => {
  const g = newGame()
  // Place the coin already behind the player (z=-2, length 1) so it is
  // collected on the immediate next step — before seed() refills new tiles.
  g.lane = 1
  g.tiles = [{ id: 1, lane: 1, z: -2, kind: 'coin', length: 1, coins: 3, passed: false }]
  step(g, 0.016, {})
  assert.equal(g.coinScore, 15, `expected coinScore 15, got ${g.coinScore}`)
  // The coin bonus must not be overwritten by the distance-based score on
  // later frames: score is always floor(distance) + coinScore.
  const afterPickup = g.score
  step(g, 0.05, {})
  const expected = Math.floor(g.distance) + 15
  assert.equal(g.score, expected, 'score regressed after pickup')
  assert(g.score >= afterPickup, 'score never goes backwards')
})

test('coins only score when the player is in the same lane', () => {
  const g = newGame()
  // Same isolation trick: coin already behind, in a lane the player is NOT in.
  g.lane = 1
  g.tiles = [{ id: 1, lane: 0, z: -2, kind: 'coin', length: 1, coins: 3, passed: false }]
  step(g, 0.016, {})
  assert.equal(g.coinScore, 0, 'coin in another lane should not score')
  // And a coin in the player's lane does score.
  g.coinScore = 0
  g.tiles = [{ id: 2, lane: 1, z: -2, kind: 'coin', length: 1, coins: 1, passed: false }]
  step(g, 0.016, {})
  assert.equal(g.coinScore, 5, 'coin in the player lane should score 1*5')
})

test('lane change is edge-triggered: holding the key moves only one lane', () => {
  const g = newGame()
  g.lane = 1
  // Press left once — exactly one lane.
  step(g, 0.016, { left: true })
  assert.equal(g.lane, 0)
  // The caller clears the input after one frame; continuing to call with no
  // input must NOT keep sliding.
  for (let i = 0; i < 10; i++) step(g, 0.016, {})
  assert.equal(g.lane, 0, 'lane kept moving after input was released')
})

test('speed ramps up at a playable rate', () => {
  const g = newGame()
  // Measure the per-frame increment over the first second, while still in the
  // coin-only safe zone and before the first lane-1 obstacle arrives (~1.5s).
  const frames = 60 // roughly 1 second at dt=0.016
  for (let i = 0; i < frames; i++) step(g, 0.016, {})
  const elapsed = frames * 0.016
  const expected = START_SPEED + ACCEL * elapsed
  assert(g.alive, 'game should stay alive during the measured ramp')
  assert(Math.abs(g.speed - expected) < 0.5, `speed ${g.speed} not near expected ${expected}`)
  // And the cap is a ~30s goal, not 340s.
  const secondsToCap = (MAX_SPEED - START_SPEED) / ACCEL
  assert(secondsToCap >= 20 && secondsToCap < 60, `cap should be reachable in roughly 30s, currently ${secondsToCap}s`)
})

test('seed never fills every lane with a wall', () => {
  // Run many seeds and assert no three tiles of the same z-block block all lanes.
  for (let i = 0; i < 50; i++) {
    const g = newGame()
    const laneBlock = new Map<number, Set<Lane>>()
    for (const t of g.tiles) {
      if (t.kind === 'coin') continue
      const key = Math.round(t.z)
      if (!laneBlock.has(key)) laneBlock.set(key, new Set())
      laneBlock.get(key)!.add(t.lane)
    }
    for (const lanes of laneBlock.values()) {
      assert(lanes.size < 3, 'all three lanes blocked at the same depth')
    }
  }
})
