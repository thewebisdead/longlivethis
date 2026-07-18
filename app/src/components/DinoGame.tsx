'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

const GROUND_Y = 280
const DINO_X = 60
const DINO_W = 44
const DINO_H = 48
const CACTUS_W = 20
const CACTUS_H = 48
const GRAVITY = 0.6
const JUMP_VEL = -13
const INITIAL_SPEED = 5
const SPEED_INCREMENT = 0.001

interface Cactus {
  x: number
  height: number
}

export default function DinoGame({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    running: false,
    dead: false,
    started: false,
    dinoY: GROUND_Y - DINO_H,
    dinoVY: 0,
    onGround: true,
    cacti: [] as Cactus[],
    score: 0,
    hiScore: 0,
    speed: INITIAL_SPEED,
    frame: 0,
    legFrame: 0,
    nextCactus: 80,
    raf: 0,
  })

  const [display, setDisplay] = useState({ score: 0, hi: 0, dead: false, started: false })

  const jump = useCallback(() => {
    const s = stateRef.current
    if (s.dead) {
      // restart
      s.dead = false
      s.started = true
      s.running = true
      s.dinoY = GROUND_Y - DINO_H
      s.dinoVY = 0
      s.onGround = true
      s.cacti = []
      s.score = 0
      s.speed = INITIAL_SPEED
      s.frame = 0
      s.legFrame = 0
      s.nextCactus = 80
      setDisplay(d => ({ ...d, dead: false, started: true, score: 0 }))
      return
    }
    if (!s.started) {
      s.started = true
      s.running = true
      setDisplay(d => ({ ...d, started: true }))
    }
    if (s.onGround) {
      s.dinoVY = JUMP_VEL
      s.onGround = false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const s = stateRef.current

    function drawDino(y: number, legFrame: number, dead: boolean) {
      ctx.save()
      ctx.fillStyle = '#ffffff'

      // body
      ctx.fillRect(DINO_X, y, DINO_W, DINO_H - 10)

      // head
      ctx.fillRect(DINO_X + DINO_W - 14, y - 16, 20, 16)

      // eye
      ctx.fillStyle = '#000000'
      ctx.fillRect(DINO_X + DINO_W + 2, y - 14, 4, 4)

      if (dead) {
        // X eyes
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(DINO_X + DINO_W + 1, y - 15, 6, 2)
        ctx.fillRect(DINO_X + DINO_W + 1, y - 11, 6, 2)
        ctx.fillRect(DINO_X + DINO_W + 1, y - 15, 2, 6)
        ctx.fillRect(DINO_X + DINO_W + 5, y - 15, 2, 6)
        ctx.fillStyle = '#000000'
        ctx.fillRect(DINO_X + DINO_W + 2, y - 14, 4, 4)
      }

      ctx.fillStyle = '#ffffff'
      // legs
      if (!dead) {
        if (legFrame < 6) {
          ctx.fillRect(DINO_X + 4, y + DINO_H - 10, 10, 12)
          ctx.fillRect(DINO_X + 20, y + DINO_H - 10, 10, 6)
        } else {
          ctx.fillRect(DINO_X + 4, y + DINO_H - 10, 10, 6)
          ctx.fillRect(DINO_X + 20, y + DINO_H - 10, 10, 12)
        }
      } else {
        ctx.fillRect(DINO_X + 4, y + DINO_H - 10, 10, 10)
        ctx.fillRect(DINO_X + 20, y + DINO_H - 10, 10, 10)
      }

      ctx.restore()
    }

    function drawCactus(x: number, height: number) {
      ctx.save()
      ctx.fillStyle = '#ffffff'
      const groundY = GROUND_Y
      // main trunk
      ctx.fillRect(x + 6, groundY - height, CACTUS_W - 12, height)
      // left arm
      ctx.fillRect(x, groundY - height + 14, 8, height / 2 - 4)
      ctx.fillRect(x, groundY - height + 14, 8, 8)
      // right arm
      ctx.fillRect(x + CACTUS_W - 8, groundY - height + 18, 8, height / 2 - 8)
      ctx.fillRect(x + CACTUS_W - 8, groundY - height + 18, 8, 8)
      ctx.restore()
    }

    function drawGround() {
      ctx.save()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, GROUND_Y + 2)
      ctx.lineTo(canvas!.width, GROUND_Y + 2)
      ctx.stroke()
      ctx.restore()
    }

    function drawScore(score: number, hi: number) {
      ctx.save()
      ctx.fillStyle = '#888888'
      ctx.font = '14px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`HI ${String(Math.floor(hi)).padStart(5, '0')}  ${String(Math.floor(score)).padStart(5, '0')}`, canvas!.width - 10, 24)
      ctx.restore()
    }

    function loop() {
      const W = canvas!.width
      ctx.clearRect(0, 0, W, canvas!.height)

      drawGround()
      drawScore(s.score, s.hiScore)

      if (!s.started) {
        drawDino(GROUND_Y - DINO_H, 0, false)
        ctx.save()
        ctx.fillStyle = '#888888'
        ctx.font = '13px monospace'
        ctx.textAlign = 'center'
        ctx.fillText('press SPACE or tap to start', W / 2, GROUND_Y + 30)
        ctx.restore()
        s.raf = requestAnimationFrame(loop)
        return
      }

      if (s.running) {
        s.frame++
        s.score += s.speed * 0.05
        s.speed = INITIAL_SPEED + s.frame * SPEED_INCREMENT

        // physics
        if (!s.onGround) {
          s.dinoVY += GRAVITY
          s.dinoY += s.dinoVY
          if (s.dinoY >= GROUND_Y - DINO_H) {
            s.dinoY = GROUND_Y - DINO_H
            s.dinoVY = 0
            s.onGround = true
          }
        }

        // leg animation
        s.legFrame = (s.legFrame + 1) % 12

        // spawn cacti
        s.nextCactus--
        if (s.nextCactus <= 0) {
          const h = CACTUS_H + Math.random() * 20
          s.cacti.push({ x: W + 20, height: h })
          s.nextCactus = 60 + Math.random() * 60
        }

        // move cacti
        for (const c of s.cacti) {
          c.x -= s.speed
        }
        s.cacti = s.cacti.filter(c => c.x > -60)

        // collision
        const dx = DINO_X + 8
        const dy = s.dinoY + 6
        const dw = DINO_W - 10
        const dh = DINO_H - 4
        for (const c of s.cacti) {
          const cx = c.x + 4
          const cy = GROUND_Y - c.height + 4
          const cw = CACTUS_W - 8
          const ch = c.height - 4
          if (dx < cx + cw && dx + dw > cx && dy < cy + ch && dy + dh > cy) {
            s.running = false
            s.dead = true
            if (s.score > s.hiScore) s.hiScore = s.score
            setDisplay({ score: s.score, hi: s.hiScore, dead: true, started: true })
            break
          }
        }
      }

      // draw cacti
      for (const c of s.cacti) {
        drawCactus(c.x, c.height)
      }

      drawDino(s.dinoY, s.legFrame, s.dead)
      drawScore(s.score, s.hiScore)

      if (s.dead) {
        ctx.save()
        ctx.fillStyle = '#ffffff'
        ctx.font = 'bold 16px monospace'
        ctx.textAlign = 'center'
        ctx.fillText('GAME OVER', W / 2, GROUND_Y / 2)
        ctx.font = '13px monospace'
        ctx.fillStyle = '#888888'
        ctx.fillText('press SPACE or tap to restart', W / 2, GROUND_Y / 2 + 24)
        ctx.restore()
      }

      s.raf = requestAnimationFrame(loop)
    }

    s.raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(s.raf)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault()
        jump()
      }
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jump, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90"
      onClick={jump}
    >
      <div
        className="border border-fg p-2 relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          className="absolute top-2 right-3 text-muted hover:text-fg text-sm font-mono z-10"
          onClick={onClose}
          aria-label="Close game"
        >
          [ESC]
        </button>
        <canvas
          ref={canvasRef}
          width={600}
          height={320}
          className="block"
          style={{ background: '#000', cursor: 'pointer' }}
          onClick={jump}
        />
        <p className="text-center text-xs text-muted mt-2 font-mono">
          SPACE / ↑ / tap to jump &nbsp;·&nbsp; ESC to close
        </p>
      </div>
    </div>
  )
}
