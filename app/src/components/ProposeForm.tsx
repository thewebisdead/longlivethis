'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProposalCategory, ProposalBenefitKind } from '@/lib/types'

const CATEGORY_OPTIONS: { value: ProposalCategory; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'feature', label: 'Feature' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'cost-saving', label: 'Cost-saving' },
]

// The economics inputs a proposer can fill in (all optional). These become
// the proposal's estimate, surfaced on the feed and later compared against the
// actual outcome once the agent implements it.
interface EconForm {
  cost: string
  recurring: string
  benefit: string
  kind: ProposalBenefitKind | ''
  runway: string
}

const EMPTY_ECON: EconForm = { cost: '', recurring: '', benefit: '', kind: '', runway: '' }

// Turn the form strings into the API body. A blank field is omitted entirely.
function econToBody(e: EconForm): Record<string, unknown> | undefined {
  const numOrUndef = (s: string): number | undefined => {
    if (s.trim() === '') return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  const out: Record<string, unknown> = {}
  const cost = numOrUndef(e.cost)
  if (cost !== undefined) out.estimatedCostUsdc = cost
  const recurring = numOrUndef(e.recurring)
  if (recurring !== undefined) out.recurringCostUsdc = recurring
  const benefit = numOrUndef(e.benefit)
  if (benefit !== undefined) out.expectedBenefitUsdc = benefit
  if (e.kind) out.benefitKind = e.kind
  const runway = numOrUndef(e.runway)
  if (runway !== undefined) out.runwayImpactDays = runway
  return Object.keys(out).length ? out : undefined
}

export default function ProposeForm({ emergencyActive = false }: { emergencyActive?: boolean }) {
  const [text, setText] = useState('')
  const [category, setCategory] = useState<ProposalCategory>('standard')
  const [econ, setEcon] = useState<EconForm>(EMPTY_ECON)
  const router = useRouter()

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    const econBody = econToBody(econ)
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: trimmed,
        category,
        ...(econBody ? { economics: econBody } : {}),
      }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      alert(j?.error || 'Could not submit right now — please try again later.')
      return
    }
    setText('')
    setEcon(EMPTY_ECON)
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
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] text-muted uppercase tracking-wider">Est. cost (USDC)</span>
          <input
            type="number"
            min="0"
            step="any"
            value={econ.cost}
            onChange={(e) => setEcon({ ...econ, cost: e.target.value })}
            placeholder="e.g. 12"
            className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 focus:outline-none placeholder:text-muted"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] text-muted uppercase tracking-wider">Recurring cost (USDC)</span>
          <input
            type="number"
            min="0"
            step="any"
            value={econ.recurring}
            onChange={(e) => setEcon({ ...econ, recurring: e.target.value })}
            placeholder="per cycle"
            className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 focus:outline-none placeholder:text-muted"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.65rem] text-muted uppercase tracking-wider">Runway impact (days)</span>
          <input
            type="number"
            step="any"
            value={econ.runway}
            onChange={(e) => setEcon({ ...econ, runway: e.target.value })}
            placeholder="+ ∞ extends"
            className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 focus:outline-none placeholder:text-muted"
          />
        </label>
        <div className="col-span-2 flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[0.65rem] text-muted uppercase tracking-wider">Benefit kind</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setEcon({ ...econ, kind: econ.kind === 'revenue' ? '' : 'revenue' })}
                className={`px-2 py-0.5 text-[0.7rem] rounded border cursor-pointer ${
                  econ.kind === 'revenue'
                    ? 'bg-emerald-900/40 text-emerald-300 border-emerald-500/50'
                    : 'bg-bg text-muted border-muted/40'
                }`}
              >
                revenue
              </button>
              <button
                type="button"
                onClick={() => setEcon({ ...econ, kind: econ.kind === 'savings' ? '' : 'savings' })}
                className={`px-2 py-0.5 text-[0.7rem] rounded border cursor-pointer ${
                  econ.kind === 'savings'
                    ? 'bg-amber-900/40 text-amber-300 border-amber-500/50'
                    : 'bg-bg text-muted border-muted/40'
                }`}
              >
                savings
              </button>
            </div>
          </div>
          <label className="flex flex-col gap-1 min-w-0 flex-1">
            <span className="text-[0.65rem] text-muted uppercase tracking-wider">Expected benefit (USDC)</span>
            <input
              type="number"
              min="0"
              step="any"
              value={econ.benefit}
              onChange={(e) => setEcon({ ...econ, benefit: e.target.value })}
              placeholder="per cycle"
              className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 focus:outline-none placeholder:text-muted"
            />
          </label>
        </div>
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
