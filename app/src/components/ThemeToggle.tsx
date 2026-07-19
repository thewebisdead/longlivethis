'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

const MODES = ['light', 'dark', 'system'] as const
type Mode = (typeof MODES)[number]

const LABELS: Record<Mode, string> = {
  light: 'light',
  dark: 'dark',
  system: 'system',
}

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Avoid hydration mismatch — render nothing until mounted
  if (!mounted) return null

  const current = (theme as Mode) ?? 'system'

  function next() {
    const idx = MODES.indexOf(current)
    setTheme(MODES[(idx + 1) % MODES.length])
  }

  return (
    <button
      onClick={next}
      title={`Theme: ${LABELS[current]} — click to cycle`}
      aria-label={`Theme: ${LABELS[current]}. Click to cycle theme`}
      className="text-xs text-muted hover:text-fg border border-muted hover:border-fg px-2 py-0.5 rounded transition-colors"
    >
      {LABELS[current]}
    </button>
  )
}
