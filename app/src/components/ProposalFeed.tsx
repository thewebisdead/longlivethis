'use client'

import { useState, useCallback } from 'react'
import type { Proposal } from '@/lib/types'
import { estimateComplexity, TIER_TITLES, type ComplexityTier } from '@/lib/complexity'

function fmt(d: string): string {
  const dt = new Date(d)
  const dd = String(dt.getDate()).padStart(2, '0')
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${dt.getFullYear()}`
}

// Sponsored proposals float to the top; then most votes; then newest.
const TIER_COLORS: Record<ComplexityTier, string> = {
  cheap: 'bg-emerald-700 text-white',
  standard: 'bg-blue-700 text-white',
  complex: 'bg-purple-700 text-white',
}

function ComplexityBadge({ text }: { text: string }) {
  const tier = estimateComplexity(text)
  return (
    <span
      title={TIER_TITLES[tier]}
      className={`inline-block text-[0.55rem] font-bold tracking-wider uppercase px-[0.4rem] py-[0.15rem] leading-tight shrink-0 ${TIER_COLORS[tier]}`}
    >
      {tier}
    </span>
  )
}

function sortProposals(proposals: Proposal[]): Proposal[] {
  return [...proposals].sort((a, b) => {
    if (a.sponsored && !b.sponsored) return -1
    if (!a.sponsored && b.sponsored) return 1
    return b.votes - a.votes || +new Date(b.created_at) - +new Date(a.created_at)
  })
}

function SponsorButton({
  proposal,
  sponsorCost,
  onSponsored,
}: {
  proposal: Proposal
  sponsorCost: number | null
  onSponsored: (id: number) => void
}) {
  const [state, setState] = useState<'idle' | 'confirm' | 'loading' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (state === 'idle') {
        setState('confirm')
      } else if (state === 'confirm') {
        setState('loading')
        fetch('/api/proposals/sponsor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: proposal.id }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const j = (await res.json().catch(() => null)) as { error?: string } | null
              throw new Error(j?.error ?? `HTTP ${res.status}`)
            }
            onSponsored(proposal.id)
          })
          .catch((err) => {
            setErrorMsg(err instanceof Error ? err.message : 'error')
            setState('error')
          })
      }
    },
    [state, proposal.id, onSponsored]
  )

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setState('idle')
    setErrorMsg('')
  }, [])

  if (proposal.sponsored) return null

  const costLabel =
    sponsorCost !== null ? `${sponsorCost.toFixed(2)} USDC` : '10% of treasury'

  if (state === 'error') {
    return (
      <span className="flex items-center gap-1 text-[0.65rem] text-muted">
        <span className="text-red-400">{errorMsg}</span>
        <button
          onClick={handleCancel}
          className="underline hover:text-fg"
        >
          dismiss
        </button>
      </span>
    )
  }

  if (state === 'loading') {
    return (
      <span className="text-[0.65rem] text-muted animate-pulse">sponsoring…</span>
    )
  }

  if (state === 'confirm') {
    return (
      <span className="flex items-center gap-1 text-[0.65rem]">
        <span className="text-muted">Boost for {costLabel}?</span>
        <button
          onClick={handleClick}
          className="text-fg underline hover:no-underline font-semibold"
        >
          confirm
        </button>
        <button
          onClick={handleCancel}
          className="text-muted underline hover:text-fg"
        >
          cancel
        </button>
      </span>
    )
  }

  return (
    <button
      onClick={handleClick}
      title={`Sponsor this proposal (${costLabel}) to boost it to the top`}
      className="text-[0.65rem] text-muted border border-muted px-[0.5rem] py-[0.2rem] hover:border-fg hover:text-fg leading-tight shrink-0"
    >
      ★ sponsor
    </button>
  )
}

export default function ProposalFeed({
  proposals: initialProposals,
  sponsorCost,
}: {
  proposals: Proposal[]
  sponsorCost: number | null
}) {
  const [proposals, setProposals] = useState<Proposal[]>(initialProposals)

  const handleSponsored = useCallback((id: number) => {
    setProposals((prev) => prev.map((p) => (p.id === id ? { ...p, sponsored: true } : p)))
  }, [])

  const rows = sortProposals(proposals)

  return (
    <div>
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mt-8 mb-4">Proposals</h2>
      <p className="text-[0.72rem] text-muted mb-4">
        Click to open a proposal on GitHub, react with 👍 to vote for it or 👎 to vote against.
        Sponsor a proposal to boost it to the top of the feed.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted text-[0.85rem]">Nothing to implement yet :( Propose something!</p>
      ) : (
        rows.map((p) => (
          <a
            key={p.id}
            href={p.url}
            target="_blank"
            rel="noopener"
            title="React on GitHub to vote"
            className="no-underline text-fg border-t border-fg last:border-b py-4 flex gap-4 items-start hover:bg-fg hover:text-bg group"
          >
            <span className="inline-block border border-fg font-mono text-[0.75rem] px-[0.6rem] py-[0.4rem] min-w-[3rem] text-center shrink-0 group-hover:border-bg">
              ▲ {p.votes}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-[0.9rem] leading-normal">{p.text}</span>
                {p.sponsored && (
                  <span className="inline-block text-[0.6rem] font-bold tracking-wider uppercase bg-yellow-400 text-black px-[0.4rem] py-[0.15rem] leading-tight shrink-0">
                    sponsored
                  </span>
                )}
                <ComplexityBadge text={p.text} />
              </span>
              <span className="flex items-center gap-3 flex-wrap">
                <span className="text-[0.72rem] text-muted group-hover:text-bg">
                  {fmt(p.created_at)}
                </span>
                <span onClick={(e) => e.stopPropagation()} className="group-hover:hidden">
                  <SponsorButton
                    proposal={p}
                    sponsorCost={sponsorCost}
                    onSponsored={handleSponsored}
                  />
                </span>
              </span>
            </span>
          </a>
        ))
      )}
    </div>
  )
}
