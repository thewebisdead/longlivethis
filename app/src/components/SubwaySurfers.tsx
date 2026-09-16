'use client'

import { useEffect, useRef, useState } from 'react'
import { newGame, step } from '@/lib/runner'
import type { RunnerState, Tile } from '@/lib/runner'

/**
 * "Corner surf" — a small, original endless-runner game fixed in the bottom
 * corner of the screen, inspired by the "Subway Surfers while you work" bit
 * everyone knows. It is NOT Subway Surfers: every visual is drawn procedurally
 * here (no real game assets), so it stays on the right side of the
 * constitution's IP rules.
 *
 * Rendered client-side so it can be fixed to the viewport regardless of page
 * scroll. Playable by mouse/keyboard/touch:
 *   - ← → or A/D : switch lanes
 *   - ↑ or W/Space : jump   - ↓ or S : roll (dodge under a train)
 * On touch, tap the left/right half of the canvas to switch lanes and tap the
 * top third to jump. Dismissible so it never blocks the page's real content.
 */

const W = 220
const H = 320

export default function SubwaySurfers() {
  const [hidden, setHidden] = useState(false)
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<RunnerState | null>(null)
  const inputRef = useRef({ left: false, right: false, jump: false, roll: false })
  const bestRef = useRef(0)
  const overRef = useRef(false)
  const scoreRef = useRef(0)

  // Keep game paused when the tab is hidden so it doesn't burn CPU for nobody.
  useEffect(() => {
    let raf = 0
    let running = true
    let last = performance.now()

    const loop = (now: number) => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      const s = stateRef.current!
      if (s.alive && !overRef.current && !document.hidden) {
        // Consume all transient (edge-triggered) inputs once per frame: jump,
        // roll, and now left/right move exactly one lane per press/tap.
        const input = inputRef.current
        const jump = input.jump
        const roll = input.roll
        const left = input.left
        const right = input.right
        input.jump = false
        input.roll = false
        input.left = false
        input.right = false
        step(s, dt, { left, right, jump, roll })
        if (!s.alive) {
          overRef.current = true
          if (s.score > bestRef.current) {
            bestRef.current = s.score
            setBest(s.score)
          }
        }
        if (scoreRef.current !== s.score) {
          scoreRef.current = s.score
          setScore(s.score)
        }
      }
      draw(canvasRef.current, stateRef.current!)
      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)
    return () => {
      running = false
      cancelAnimationFrame(raf)
    }
  }, [])

  // Initialise once.
  useEffect(() => {
    stateRef.current = newGame()
    overRef.current = false
  }, [])

  const start = () => {
    stateRef.current = newGame()
    overRef.current = false
    setScore(0)
  }

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (overRef.current) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); start() }
        return
      }
      const i = inputRef.current
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          i.left = true
          break
        case 'ArrowRight':
        case 'd':
        case 'D':
          i.right = true
          break
        case 'ArrowUp':
        case 'w':
        case 'W':
          i.jump = true
          break
        case ' ':
          i.jump = true
          break
        case 'ArrowDown':
        case 's':
        case 'S':
          i.roll = true
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Touch/mouse controls on the canvas — no gesture needed to play. Each tap
  // is a discrete event: left/right fire exactly once and are consumed by the
  // next frame, like jump/roll, so they never jam the controls for the
  // session.
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (overRef.current) {
      start()
      return
    }
    const i = inputRef.current
    if (y < rect.height * 0.4) {
      i.jump = true
    } else if (y > rect.height * 0.7) {
      i.roll = true
    } else if (x < rect.width * 0.45) {
      i.left = true
    } else if (x > rect.width * 0.55) {
      i.right = true
    }
  }

  if (hidden) return null

  return (
    <div
      className="fixed bottom-3 right-3 z-50 select-none"
      aria-label="Corner surf — a playable endless runner in the corner"
    >
      <div className="overflow-hidden rounded-lg border border-white/20 shadow-2xl bg-black">
        <div className="flex items-center justify-between gap-2 bg-black/80 px-2 py-1 text-[0.6rem] text-white">
          <span className="font-bold tracking-wide">CORNER SURF</span>
          <span className="tabular-nums">
            <span className="text-amber-400">★ {best}</span> · {score}
          </span>
          <button type="button" onClick={() => setHidden(true)} className="hover:underline" aria-label="close game">
            ✕
          </button>
        </div>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={{ width: W, height: H, display: 'block', touchAction: 'none', cursor: 'pointer' }}
          onPointerDown={onPointer}
        />
        <div className="bg-black/70 px-2 py-1 text-[0.55rem] text-muted">
          ←→ switch lane · ↑ jump · ↓ roll · tap to play
        </div>
      </div>
    </div>
  )
}

/** Draw one frame of the game to the canvas. */
function draw(canvas: HTMLCanvasElement | null, s: RunnerState): void {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const w = canvas.width
  const h = canvas.height
  const horizon = h * 0.35
  const ground = h * 0.95
  const cz = 26 // camera distance

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon)
  sky.addColorStop(0, '#0a0f2a')
  sky.addColorStop(1, '#1b2440')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, w, h)

  // Ground
  ctx.fillStyle = '#2a2a3a'
  ctx.fillRect(0, horizon, w, h - horizon)

  // Perspective helper: map world (laneOffset, z) to screen (x, y, scale).
  // scale = cz/(z + cz) — 1 at the player and falling off with distance — so
  // the near track is huge and visible instead of collapsing to a few pixels.
  const proj = (laneOffset: number, z: number) => {
    const d = Math.max(0.1, z + cz)
    const scale = cz / d
    const x = w / 2 + laneOffset * ((w / 2) * 0.55) * scale
    const y = horizon + (ground - horizon) * scale
    return { x, y, scale }
  }

  // Draw the three lanes converging to the horizon.
  for (let lane = -1; lane <= 1; lane++) {
    const pNear = proj(lane * 1.5, 0.1)
    const pFar = proj(lane * 1.5, 30)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(pNear.x, pNear.y)
    ctx.lineTo(pFar.x, pFar.y)
    ctx.stroke()
  }

  // Draw runner at the base of its lane (the player is centred on the
  // horizontal axis only when in the middle lane), jumping height lifts it up.
  const playerZ = 0.6
  const playerLaneOffset = (s.lane - 1) * 1.5
  const p = proj(playerLaneOffset, playerZ)
  const jumpLift = s.height * 22 * p.scale
  const runY = p.y
  drawRunner(ctx, p.x, runY - jumpLift, p.scale, s)

  // Draw tiles (obstacles/coins) farthest → nearest so nearer overlap older.
  const sorted = [...s.tiles].sort((a, b) => b.z - a.z)
  for (const t of sorted) {
    if (t.z > 30 || t.z + t.length < -1) continue
    const laneOffset = (t.lane - 1) * 1.5
    drawTile(ctx, t, laneOffset, proj, w)
  }

  // Game over overlay
  if (!s.alive) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 18px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillText('GAME OVER', w / 2, h / 2 - 12)
    ctx.fillStyle = '#ffcc00'
    ctx.font = '12px ui-monospace, monospace'
    ctx.fillText(`score ${s.score}`, w / 2, h / 2 + 10)
    ctx.fillStyle = '#fff'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText('tap / Enter to restart', w / 2, h / 2 + 30)
  }
}

function drawRunner(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, s: RunnerState): void {
  ctx.save()
  ctx.translate(x, y)
  // ~40px tall at the player's scale (scale≈1); the runner's body+head spans
  // about 14 world units, so a factor of 3 lands right at ~40px.
  const rScale = scale * 3
  ctx.scale(rScale, rScale)

  // Simple 3D-ish runner: body + head, bobbing as it runs.
  const bob = s.alive ? Math.sin(s.runTime * 20) * 0.8 : 0
  const squash = s.rolling ? 0.5 : 1

  ctx.scale(1, squash)
  // Legs
  ctx.fillStyle = '#4a90d9'
  ctx.fillRect(-2.5, 3 + bob, 2, 4 - bob)
  ctx.fillRect(0.5, 3 - bob, 2, 4 + bob)
  // Body (tunic)
  ctx.fillStyle = '#e64a3c'
  ctx.fillRect(-2, -3, 5, 6)
  // Head
  ctx.fillStyle = '#ffe0bd'
  ctx.beginPath()
  ctx.arc(0.5, -5, 2, 0, Math.PI * 2)
  ctx.fill()
  // Cap (a touch of character, original not trademarked)
  ctx.fillStyle = '#222'
  ctx.beginPath()
  ctx.arc(0.5, -5.4, 2, Math.PI, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(-0.5, -5.4, 2.2, Math.PI * 0.8, Math.PI * 1.4)
  ctx.fill()

  ctx.restore()
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  t: Tile,
  laneOffset: number,
  proj: (lane: number, z: number) => { x: number; y: number; scale: number },
  w: number
): void {
  if (t.kind === 'coin') {
    // A small glowing coin, bobbing gently.
    const wobble = Math.sin(t.z * 0.8 + t.id) * 0.02
    const pos = proj(laneOffset, t.z + 0.5 + wobble)
    // No floor — the projection already scales the coin naturally with depth.
    const r = Math.max(1, 4 * pos.scale)
    ctx.fillStyle = '#ffd700'
    ctx.beginPath()
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#b8860b'
    ctx.lineWidth = 1
    ctx.stroke()
    return
  }

  const pBack = proj(laneOffset, t.z + t.length)
  const pFront = proj(laneOffset, t.z)
  // Width of one lane on screen at the near plane, in px: the same factor used
  // to space the lane lines, so a tile fills its lane (not a 1px sliver).
  const laneW = 1.5 * ((w / 2) * 0.55) * pFront.scale

  if (t.kind === 'gap') {
    // A hole in the track — draw darker void.
    ctx.fillStyle = '#0a0a0f'
    ctx.beginPath()
    ctx.moveTo(pBack.x, pBack.y)
    ctx.lineTo(pFront.x, pFront.y)
    ctx.lineTo(pFront.x + laneW, pFront.y)
    ctx.lineTo(pBack.x + (1.5 * ((w / 2) * 0.55) * pBack.scale), pBack.y)
    ctx.closePath()
    ctx.fill()
    return
  }

  const height = t.kind === 'barrier' ? 6 : 9
  // Train/barrier as a 3D box. Heights scale with the projection as well, and
  // are multiplied to read clearly on screen (compare with the ~40px runner).
  const heightMul = 4.5
  const hF = height * heightMul * pFront.scale
  const hB = height * heightMul * pBack.scale
  const wB = 1.5 * ((w / 2) * 0.55) * pBack.scale
  // Roof
  ctx.fillStyle = t.kind === 'barrier' ? '#b08d3a' : '#5ec2e6'
  ctx.beginPath()
  ctx.moveTo(pBack.x, pBack.y - hB)
  ctx.lineTo(pFront.x, pFront.y - hF)
  ctx.lineTo(pFront.x + laneW, pFront.y - hF)
  ctx.lineTo(pBack.x + wB, pBack.y - hB)
  ctx.closePath()
  ctx.fill()
  // Face
  ctx.fillStyle = t.kind === 'barrier' ? '#8a6d1f' : '#4aa8cc'
  ctx.fillRect(pFront.x, pFront.y - hF, laneW, hF)
  // A front bumper/edge for depth.
  ctx.fillStyle = t.kind === 'barrier' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)'
  ctx.fillRect(pFront.x, pFront.y - hF, laneW, Math.max(1, pFront.scale * 2))
  // Windows on trains for a hint of the original genre without any asset.
  if (t.kind === 'train') {
    ctx.fillStyle = 'rgba(200,230,255,0.9)'
    ctx.fillRect(pFront.x + 2 * pFront.scale, pFront.y - hF * 0.75, laneW - 4 * pFront.scale, hF * 0.25)
  }
}
