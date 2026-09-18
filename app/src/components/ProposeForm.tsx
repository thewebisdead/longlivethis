'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProposalCategory } from '@/lib/types'

const CATEGORY_OPTIONS: { value: ProposalCategory; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'feature', label: 'Feature' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'cost-saving', label: 'Cost-saving' },
]

export default function ProposeForm({ emergencyActive = false }: { emergencyActive?: boolean }) {
  const [text, setText] = useState('')
  const [category, setCategory] = useState<ProposalCategory>('standard')
  const router = useRouter()

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, category }),
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
      <div className="mt-2 flex flex-wrap gap-2 items-center">
        <span className="text-[0.7rem] text-muted uppercase tracking-wider">Category</span>
        {CATEGORY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setCategory(opt.value)}
            className={`px-2 py-0.5 text-[0.7rem] font-semibold rounded border transition-colors cursor-pointer ${
              category === opt.value
                ? opt.value === 'revenue'
                  ? 'bg-emerald-900/40 text-emerald-300 border-emerald-500/50'
                  : opt.value === 'cost-saving'
                    ? 'bg-amber-900/40 text-amber-300 border-amber-500/50'
                    : opt.value === 'feature'
                      ? 'bg-blue-900/40 text-blue-300 border-blue-500/50'
                      : 'bg-fg text-bg border-fg'
                : 'bg-bg text-muted border-muted/40 hover:text-fg'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <button
        onClick={submit}
        className="mt-3 bg-fg text-bg border border-fg px-[1.1rem] py-[0.55rem] text-[0.85rem] font-semibold cursor-pointer hover:bg-bg hover:text-fg"
      >
        Submit
      </button>
    </div>
  )
}
