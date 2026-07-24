'use client'

import { useEffect, useState } from 'react'

// Pizza counter: increments at ~1 pizza every 30 seconds (2/min)
// seeded from a fixed epoch so it's consistent across page loads
const EPOCH = new Date('2025-01-01T00:00:00Z').getTime()
const RATE_PER_MS = 2 / (60 * 1000) // 2 pizzas per minute

function getPizzaCount(): number {
  const elapsed = Date.now() - EPOCH
  return Math.floor(elapsed * RATE_PER_MS)
}

export default function PizzaCounter() {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    setCount(getPizzaCount())
    const interval = setInterval(() => {
      setCount(getPizzaCount())
    }, 500)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>🍕</span>
      <span>
        pizzas made:{' '}
        <span className="text-fg font-mono">
          {count === null ? '…' : count.toLocaleString()}
        </span>
      </span>
    </div>
  )
}
