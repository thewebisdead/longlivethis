'use client'

import { useState } from 'react'

/**
 * Copies a value to the clipboard and briefly confirms it inline.
 *
 * The treasury is a bare address a visitor must paste into their own wallet,
 * so a click-to-copy is the difference between donating and hunting for a
 * copy button. Uses the async Clipboard API when available, falling back to
 * the legacy execCommand path for older/odd browsers. No clipboard permission
 * is ever requested — reading is not part of this button.
 */
export default function CopyAddress({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        // Legacy fallback: a hidden textarea + execCommand. Not async, so it
        // either works or throws synchronously — both land in the same catch.
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        if (!ok) throw new Error('copy failed')
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked or unavailable — surface the address some other way:
      // the label doubles as the target, and the explorer link is a fallback.
      setCopied(false)
    }
  }

  return (
    <button
      onClick={copy}
      type="button"
      className="inline-flex items-center gap-1.5 border border-fg px-2.5 py-1 text-[0.75rem] font-mono text-fg cursor-pointer hover:bg-fg hover:text-bg focus:outline-none"
      aria-label={`Copy ${label} to clipboard`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <span className="truncate max-w-[9rem]">{copied ? 'Copied!' : label}</span>
    </button>
  )
}
