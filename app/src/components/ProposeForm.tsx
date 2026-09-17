'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ProposeForm({ emergencyActive = false }: { emergencyActive?: boolean }) {
  const [text, setText] = useState('')
  const router = useRouter()

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      alert(j?.error || 'Could not submit right now — please try again later.')
      return
    }
    setText('')
    // Re-render the server page so the new proposal shows up in the feed.
    router.refresh()
  }

  return (
    <div>
      {emergencyActive && (
        <p className="mb-3 text-[0.72rem] text-amber-300 border border-amber-500/30 bg-amber-950/20 rounded px-3 py-2">
          ⚠ Emergency Survival Mode: proposals that <strong>reduce costs</strong> or{' '}
          <strong>generate revenue</strong> are prioritized for implementation.
        </p>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Propose a feature that helps this app survive"
        className="w-full bg-bg border border-fg text-fg font-mono text-[0.9rem] p-3 resize-y min-h-[72px] placeholder:text-muted focus:outline-none"
      />
      <button
        onClick={submit}
        className="mt-3 bg-fg text-bg border border-fg px-[1.1rem] py-[0.55rem] text-[0.85rem] font-semibold cursor-pointer hover:bg-bg hover:text-fg"
      >
        Submit
      </button>
    </div>
  )
}
