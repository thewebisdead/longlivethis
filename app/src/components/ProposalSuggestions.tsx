'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProposalSuggestion } from '@/lib/proposalSuggester'

interface Suggestion extends ProposalSuggestion {
  id: number
}

/**
 * "Auto-suggested proposals" panel — the app drafts proposal ideas itself,
 * grounded in the current treasury and runway, and offers them to visitors to
 * adopt as real proposals with one click. Each suggestion's "Adopt" button
 * submits it through the same /api/proposals intake as a hand-typed one, so an
 * adopted suggestion is just a normal proposal subject to the same duplicate
 * check, cap and voting.
 *
 * The generation is deterministic (see lib/proposalSuggester) — no paid
 * inference at runtime — so the panel works with no credentials on the VPS.
 */
export default function ProposalSuggestions({
  suggestions,
  generatedAt,
  emergencyActive = false,
}: {
  suggestions: Suggestion[]
  generatedAt: number | null
  emergencyActive?: boolean
}) {
  const [adopting, setAdopting] = useState<number | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function adopt(s: Suggestion) {
    if (adopting !== null) return
    setAdopting(s.id)
    setError(null)
    try {
      const text = `${s.title}\n\n${s.description}${s.reason ? `\n\n(automatically suggested — ${s.reason})` : ''}`
      const res = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, category: s.lever === 'revenue' ? 'revenue' : s.lever === 'cost-saving' ? 'cost-saving' : 'feature' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        setError(j?.error || 'Could not submit right now — please try again later.')
        return
      }
      // Re-render the server page so the new proposal appears in the feed.
      router.refresh()
    } finally {
      setAdopting(null)
    }
  }

  async function regenerate() {
    if (regenerating) return
    setRegenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/suggestions', { method: 'POST' })
      if (res.ok) {
        const j = await res.json().catch(() => null)
        if (j && typeof j.ok === 'boolean' && !j.ok && j.suggestions && j.suggestions.length > 0) {
          // Cooldown hit — same batch returned; fine to just refresh.
        }
      }
      router.refresh()
    } finally {
      setRegenerating(false)
    }
  }

  if (suggestions.length === 0) return null

  const leverTag = (lever: Suggestion['lever']) =>
    lever === 'revenue'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-500/40'
      : lever === 'cost-saving'
        ? 'bg-amber-900/40 text-amber-300 border-amber-500/40'
        : 'bg-blue-900/40 text-blue-300 border-blue-500/40'
  const leverLabel = (lever: Suggestion['lever']) =>
    lever === 'revenue' ? 'revenue' : lever === 'cost-saving' ? 'cost-saving' : 'engagement'

  return (
    <div className="mt-8 border border-violet-500/30 rounded-lg px-4 py-4 bg-violet-950/10">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[0.8rem] font-bold tracking-widest uppercase">
          ✨ Auto-suggested proposals
        </h2>
        <div className="flex items-center gap-2">
          {generatedAt && (
            <span className="text-[0.7rem] text-muted">
              {new Date(generatedAt).toLocaleDateString()}
            </span>
          )}
          <button
            onClick={regenerate}
            disabled={regenerating}
            className="text-[0.7rem] font-semibold text-muted underline underline-offset-2 hover:text-fg disabled:opacity-50 cursor-pointer"
          >
            {regenerating ? '…' : 'regenerate'}
          </button>
        </div>
      </div>
      <p className="text-[0.72rem] text-muted mb-3">
        The app suggested these itself, based on the current treasury, runway and
        open proposals. One click adopts one as a real proposal for everyone to vote on.
      </p>
      {emergencyActive && (
        <p className="mb-3 text-[0.7rem] text-amber-300 border border-amber-500/30 bg-amber-950/20 rounded px-3 py-2">
          ⚠ Emergency Survival Mode — revenue and cost-saving suggestions are prioritized.
        </p>
      )}
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div
            key={s.id}
            className="text-sm border border-muted/30 rounded px-3 py-2 flex items-start gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-[0.85rem]">{s.title}</span>
                <span
                  className={`inline-block text-[0.6rem] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${leverTag(s.lever)}`}
                >
                  {leverLabel(s.lever)}
                </span>
              </div>
              <p className="text-[0.72rem] text-muted mt-0.5">{s.description}</p>
              {s.reason && (
                <p className="text-[0.68rem] text-violet-300/70 mt-0.5 italic">{s.reason}</p>
              )}
            </div>
            <button
              onClick={() => adopt(s)}
              disabled={adopting !== null}
              className="shrink-0 bg-fg text-bg border border-fg px-3 py-1.5 text-[0.72rem] font-semibold cursor-pointer hover:bg-bg hover:text-fg disabled:opacity-50 disabled:cursor-default transition-colors"
            >
              {adopting === s.id ? 'Submitting…' : 'Adopt →'}
            </button>
          </div>
        ))}
      </div>
      {error && <p className="text-[0.72rem] text-red-400 mt-2">{error}</p>}
    </div>
  )
}
