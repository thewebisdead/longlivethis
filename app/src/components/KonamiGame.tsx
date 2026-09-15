'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { feedKonami } from '@/lib/konami'

/**
 * The Konami code (↑ ↑ ↓ ↓ ← → ← → B A) unlocks a hidden mini game — a
 * catch-the-coins arcade bit nestled into the longlivethis treasury.
 *
 * The game is rendered client-side as an overlay. Coins (the treasury's USDC)
 * fall from the top; you steer a basket with the arrow keys / A-D to catch
 * them. Catching a coin adds to the score. Avoid nothing — it's a cheerful
 * little loop, filed under "the web is dead, have some fun".
 *
 * Design choices (all deliberate, none requiring infra):
 * - Pure DOM/CSS with requestAnimationFrame — no canvas, no assets, no
 *   dependencies. Works the moment the overlay mounts.
 * - Codepoints rendered as text so there's nothing to fetch or bundle.
 * - Keyboard-driven and restartable; ESC or ✕ closes back to the page.
 */

const COIN_CHARS = ['$', '◉', '¢', '₿', '◎']
const WIDTH = 320
const HEIGHT = 420
const BASKET_W = 64
const BASKET_H = 18
const COIN_R = 16
const COIN_SPEED_MIN = 90
const COIN_SPEED_MAX = 170

interface Falling {
  id: number
  x: number
  y: number
  vy: number
  char: string
}

export default function KonamiGame() {
  const [open, setOpen] = useState(false)
  const [score, setScore] = useState(0)
  const [runId, setRunId] = useState(0) // bump to restart

  // Konami sequence tracking — kept in a ref so the key listener stays stable.
  const seqRef = useRef<string[]>([])
  const keysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Ignore pure modifier/utility keys so they never corrupt the sequence.
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape'].includes(e.key)) {
        if (e.key === 'Escape') setOpen(false)
        return
      }
      if (open) {
        const k = e.key
        if (['ArrowLeft', 'a', 'A'].includes(k)) {
          e.preventDefault()
          keysRef.current.add('ArrowLeft')
        } else if (['ArrowRight', 'd', 'D'].includes(k)) {
          e.preventDefault()
          keysRef.current.add('ArrowRight')
        }
        return
      }
      const done = feedKonami(seqRef.current, e.key)
      if (done) {
        setOpen(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'a' || k === 'A' || k === 'd' || k === 'D') {
        keysRef.current.delete(k === 'a' || k === 'A' ? 'ArrowLeft' : 'ArrowRight')
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [open])

  // Game loop — runs only while the overlay is open.
  useEffect(() => {
    if (!open) return
    setScore(0)

    let raf = 0
    let last = performance.now()
    let basketX = WIDTH / 2 - BASKET_W / 2
    let coins: Falling[] = []
    let nextId = 1
    let spawnAcc = 0
    let s = 0
    const spawnEvery = 950

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      // Steering.
      const left = keysRef.current.has('ArrowLeft')
      const right = keysRef.current.has('ArrowRight')
      const speed = 260
      if (left) basketX = Math.max(0, basketX - speed * dt)
      if (right) basketX = Math.min(WIDTH - BASKET_W, basketX + speed * dt)

      // Spawn coins.
      spawnAcc += dt * 1000
      while (spawnAcc >= spawnEvery) {
        spawnAcc -= spawnEvery
        const x = COIN_R + Math.random() * (WIDTH - COIN_R * 2)
        const vy = COIN_SPEED_MIN + Math.random() * (COIN_SPEED_MAX - COIN_SPEED_MIN)
        coins.push({
          id: nextId++,
          x,
          y: -COIN_R,
          vy,
          char: COIN_CHARS[Math.floor(Math.random() * COIN_CHARS.length)],
        })
      }

      // Move + collide.
      coins = coins.filter((c) => {
        c.y += c.vy * dt
        if (c.y > HEIGHT + COIN_R) return false // fell past, missed
        // Basket catch.
        if (
          c.y + COIN_R >= HEIGHT - BASKET_H &&
          c.y - COIN_R <= HEIGHT &&
          c.x >= basketX - COIN_R &&
          c.x <= basketX + BASKET_W + COIN_R
        ) {
          s += 1
          setScore(s)
          return false
        }
        return true
      })

      // Render via ref to avoid re-render churn inside the loop.
      if (stageRef.current) {
        stageRef.current.innerHTML = ''
        for (const c of coins) {
          const el = document.createElement('span')
          el.textContent = c.char
          el.className =
            'absolute select-none leading-none text-center text-xl'
          el.style.left = `${c.x - COIN_R}px`
          el.style.top = `${c.y - COIN_R}px`
          el.style.width = `${COIN_R * 2}px`
          el.style.height = `${COIN_R * 2}px`
          stageRef.current.appendChild(el)
        }
        if (basketRef.current) {
          basketRef.current.style.transform = `translateX(${basketX}px)`
        }
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [open, runId])

  // Re-render, but the loop uses refs directly. Reset the stage each run.
  useEffect(() => {
    if (!open) return
    if (stageRef.current) stageRef.current.innerHTML = ''
  }, [open, runId])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const basketRef = useRef<HTMLDivElement | null>(null)

  const restart = useCallback(() => setRunId((r) => r + 1), [])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Konami code mini game"
    >
      <div className="bg-bg border border-white/20 rounded-xl p-4 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-bold tracking-wide uppercase">
            💰 Treasury Catch
          </p>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="tabular-nums">coins: {score}</span>
            <button
              type="button"
              onClick={restart}
              className="hover:underline"
            >
              ↻ restart
            </button>
            <button type="button" onClick={() => setOpen(false)} className="hover:underline">
              ✕ close
            </button>
          </div>
        </div>
        <div
          className="relative overflow-hidden border border-white/15 rounded-lg"
          style={{ width: WIDTH, height: HEIGHT }}
        >
          <div
            ref={stageRef}
            className="absolute inset-0"
          >
            <span className="absolute inset-0 flex items-end justify-center pb-20 text-[0.7rem] text-muted">
              ← → steer · catch the coins
            </span>
          </div>
          <div
            ref={basketRef}
            className="absolute bottom-0 left-0"
            style={{ width: BASKET_W, height: BASKET_H }}
          >
            <div className="w-full h-full bg-fg/90 rounded-md" />
          </div>
        </div>
        <p className="mt-3 text-[0.65rem] text-muted">
          typed the Konami code — nice. ESC or ✕ to get back to the treasury.
        </p>
      </div>
    </div>
  )
}
