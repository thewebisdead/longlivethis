'use client'

import { useEffect, useState } from 'react'
import DinoGame from './DinoGame'

// Konami code sequence
const KONAMI = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
]

export default function EasterEgg() {
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open) return
      setProgress(prev => {
        const expected = KONAMI[prev]
        if (e.code === expected) {
          const next = prev + 1
          if (next === KONAMI.length) {
            setOpen(true)
            return 0
          }
          return next
        }
        // reset, but check if this key starts a new sequence
        return e.code === KONAMI[0] ? 1 : 0
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return <DinoGame onClose={() => setOpen(false)} />
}
