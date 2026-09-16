/**
 * Core logic for the endless-runner mini game ("corner surf").
 *
 * Pure state + simulation, no canvas/DOM, so it is unit-testable in Node.
 * The React component just drives this with a fixed timestep and draws the
 * resulting state on a <canvas>.
 *
 * Original art (procedurally drawn shapes — no real game assets, per the
 * request) and original mechanics reminiscent of the genre: run down 3 lanes,
 * dodge obstacles by switching lanes or jumping, speed up over time.
 */

export type Lane = 0 | 1 | 2

export interface RunnerState {
  lane: Lane
  /** Height above the track, in world tiles (1 = a full jump). */
  height: number
  velY: number
  /** Tumbling while rolling under barriers. */
  rolling: boolean
  collided: boolean
  alive: boolean
  distance: number
  speed: number
  score: number
  /** Coins collected this run — added to score on top of distance. */
  coinScore: number
  /** Tiles being drawn; each is `{ lane, z (distance ahead), kind }`. */
  tiles: Tile[]
  rollTimer: number
  runTime: number
}

export type TileKind = 'train' | 'barrier' | 'gap' | 'coin'

export interface Tile {
  id: number
  lane: Lane
  z: number
  kind: TileKind
  /** For trains/gaps: length in tiles. */
  length: number
  /** Coins: 1..3 in a row. */
  coins: number
  /** Whether the tile has scrolled behind the player. */
  passed: boolean
}

export const START_SPEED = 6
export const MAX_SPEED = 18
export const ACCEL = 0.4
export const JUMP_VELOCITY = 12
export const GRAVITY = 26
export const ROLL_TIME = 0.45
/** How many tiles of track exist ahead of the player at any time. */
export const TRACK_LENGTH = 60
/** Tile (world unit) width of one lane. */
export const LANE_WIDTH = 1
/** A gap/barrier this many tiles ahead becomes crossable by jumping. */
export const JUMP_CLEAR = 1

let nextId = 1
function freshId(): number {
  return nextId++
}

/** Create a fresh run. */
export function newGame(): RunnerState {
  nextId = 1
  const s: RunnerState = {
    lane: 1,
    height: 0,
    velY: 0,
    rolling: false,
    collided: false,
    alive: true,
    distance: 0,
    speed: START_SPEED,
    score: 0,
    coinScore: 0,
    tiles: [],
    rollTimer: 0,
    runTime: 0,
  }
  seed(s)
  return s
}

function randomLane(): Lane {
  return (Math.floor(Math.random() * 3)) as Lane
}

/** A lane different from both `a` and `b`. */
function differentLane(a: Lane, b: Lane): Lane {
  if (a !== b) return (3 - a - b) as Lane
  return ((a + 1) % 3) as Lane
}

/** A three-lane value 0..2 that keeps clear of occupied lanes when spillover. */
function clearLane(occupied: Set<Lane>): Lane {
  if (!occupied.has(0)) return 0
  if (!occupied.has(1)) return 1
  return 2
}

/**
 * Fill tiles from the current max ahead up to TRACK_LENGTH with obstacles etc.
 * Guarantees every lane is negotiable: never a wall covering all 3 lanes, and
 * always a gap between consecutive obstacles large enough to recover.
 *
 * The safe zone (z < SAFE_ZONE) ensures no obstacle blocks lane 1 (starting
 * lane) and no obstacle at all is placed closer than z=10, so every fresh run
 * is winnable from frame one.
 */
export const SAFE_ZONE = 10

export function seed(s: RunnerState): void {
  // Densify the near track if sparse (fresh game).
  const maxZ = s.tiles.reduce((m, t) => Math.max(m, t.z + t.length), 0) ?? 0
  let z = Math.max(1, Math.ceil(maxZ))
  // Existing tiles already cover [0, maxZ); only append beyond that.
  z = Math.max(z, 1)

  while (z < TRACK_LENGTH) {
    // Ensure we don't place directly on top of the previous obstacle lane.
    // Filter the window once per loop but only over a cheap slice (all tiles
    // are un-passed near the front, so this is bounded).
    const prev = s.tiles.filter((t) => !t.passed && t.z + t.length <= z && t.z >= z - 6)
    const occupied = new Set<Lane>()
    for (const t of prev) occupied.add(t.lane)

    // Before the safe zone only coins spawn: no obstacle may even exist there,
    // so a fresh run is always winnable from frame one.
    if (z < SAFE_ZONE) {
      const lane = occupied.size ? clearLane(occupied) : randomLane()
      const coins = 1 + Math.floor(Math.random() * 3)
      s.tiles.push({ id: freshId(), lane, z, kind: 'coin', length: 1, coins, passed: false })
      z += coins + 1
      continue
    }

    const roll = Math.random()
    if (roll < 0.45) {
      // A train occupies one lane, length 2-4.
      const lane = occupied.size >= 2 ? clearLane(occupied) : randomLane()
      s.tiles.push({ id: freshId(), lane, z, kind: 'train', length: 2 + Math.floor(Math.random() * 3), coins: 0, passed: false })
      z += 4 + Math.floor(Math.random() * 2)
    } else if (roll < 0.6) {
      // A low barrier: jump over it (or roll? it's tall — jump).
      const lane = occupied.size >= 2 ? clearLane(occupied) : randomLane()
      s.tiles.push({ id: freshId(), lane, z, kind: 'barrier', length: 1, coins: 0, passed: false })
      z += 3 + Math.floor(Math.random() * 2)
    } else if (roll < 0.72) {
      // A track gap: must jump to cross. Occupies all lanes logically.
      const len = 1 + (Math.random() < 0.3 ? 1 : 0)
      // The gap sits in a lane clear of the previous tile's lane (and, when
      // possible, of the player's starting lane too).
      const refLane = s.tiles.length ? s.tiles[s.tiles.length - 1].lane : randomLane()
      s.tiles.push({ id: freshId(), lane: differentLane(refLane, 1), z, kind: 'gap', length: len, coins: 0, passed: false })
      z += len + 3
    } else {
      // Coins — always safe, place in an empty(-ish) lane.
      const lane = occupied.size ? clearLane(occupied) : randomLane()
      const coins = 1 + Math.floor(Math.random() * 3)
      s.tiles.push({ id: freshId(), lane, z, kind: 'coin', length: 1, coins, passed: false })
      z += coins + 1
    }
  }
}

/**
 * Advance the sim by `dt` seconds. `input` is the desired action for this
 * frame (left/right switch, jump, roll — already debounced by caller).
 */
export function step(s: RunnerState, dt: number, input: { left?: boolean; right?: boolean; jump?: boolean; roll?: boolean }): void {
  if (!s.alive) return

  s.runTime += dt
  // Speed ramps up, capped.
  s.speed = Math.min(MAX_SPEED, s.speed + ACCEL * dt)
  s.distance += s.speed * dt
  s.score = Math.floor(s.distance) + s.coinScore

  // Physics: vertical.
  if (s.height > 0 || s.velY !== 0) {
    s.velY -= GRAVITY * dt
    s.height += s.velY * dt
    if (s.height <= 0) {
      s.height = 0
      s.velY = 0
    }
  }

  // Rolling timer / touch-down.
  if (s.rollTimer > 0) {
    s.rollTimer -= dt
    if (s.rollTimer <= 0) {
      s.rollTimer = 0
      s.rolling = false
    }
  }

  // Input handling — only when on the ground. left/right are edge-triggered:
  // each press moves exactly one lane (the caller signals a discrete press
  // once, not a held key).
  if (s.height <= 0 && !s.rolling) {
    if (input.left && s.lane > 0) s.lane = (s.lane - 1) as Lane
    else if (input.right && s.lane < 2) s.lane = (s.lane + 1) as Lane
    if (input.jump) {
      s.velY = JUMP_VELOCITY
      s.height = 0.01
    }
    if (input.roll) {
      s.rolling = true
      s.rollTimer = ROLL_TIME
    }
  }

  // Move tiles toward the player.
  const PL = 0.4 // player half-length in tiles
  for (const t of s.tiles) {
    t.z -= s.speed * dt
    // Mark passed when fully behind the player zone.
    if (t.z + t.length <= -PL && !t.passed) {
      t.passed = true
      if (t.kind === 'coin' && t.lane === s.lane) s.coinScore += t.coins * 5
    }
  }

  // Collision: an obstacle in the same lane whose depth band overlaps the
  // player ([z, z+length] ∩ [-PL, PL]) — unless the player evades by jumping
  // (barriers/gaps/trains) or rolling (trains).
  if (!s.collided) {
    for (const t of s.tiles) {
      if (t.kind === 'coin' || t.passed) continue
      if (t.lane !== s.lane) continue
      const overlaps = t.z <= PL && t.z + t.length >= -PL
      if (!overlaps) continue
      const low = s.height < 0.6
      if (t.kind === 'gap') {
        // Must be airborne to cross a gap.
        if (low) { s.collided = true; s.alive = false; break }
      } else if (t.kind === 'barrier') {
        // Tall barrier: must jump.
        if (low) { s.collided = true; s.alive = false; break }
      } else {
        // Train from the side (distinct lane) never hits the lane we're not in.
        // Tall train: jump over, or roll under a low one. Treat all trains as
        // needing height OR being clearable by roll.
        if (s.height < 0.9 && !s.rolling) { s.collided = true; s.alive = false; break }
      }
    }
  }

  // Keep tile queue full ahead.
  seed(s)

  // Prune old tiles far behind.
  s.tiles = s.tiles.filter((t) => t.z + t.length > -2)
}
