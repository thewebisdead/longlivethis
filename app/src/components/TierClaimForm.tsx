'use client'

import { useState, useRef, useEffect } from 'react'
// Only import the tier definitions (pure constants), never the store I/O.
import { DONATION_TIERS } from '@/lib/donationTiers.common';

/**
 * A small inline form that lets a supporter claim a donation reward tier.
 *
 * After donating, a visitor opens this form, picks the tier they funded, and
 * enters their display name. The claim is self-attesting — no proof, no
 * attribution, just a public acknowledgement board.
 */
export default function TierClaimForm() {
  const [open, setOpen] = useState(false)
  const [tierId, setTierId] = useState(DONATION_TIERS[0].id)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'ok' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const formRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setStatus('submitting')
    setErrorMsg('')
    try {
      const res = await fetch('/api/donation-tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tierId,
          name: name.trim(),
          address: address.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'claim failed' }))
        throw new Error(err.error || 'claim failed')
      }
      setStatus('ok')
      setName('')
      setAddress('')
      // Auto-close after a short delay
      setTimeout(() => {
        setOpen(false)
        setStatus('idle')
      }, 2000)
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'claim failed')
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[0.7rem] text-muted underline underline-offset-2 hover:text-fg cursor-pointer"
      >
        Claim a reward tier →
      </button>
    )
  }

  return (
    <div ref={formRef} className="relative mt-3 border border-muted/30 rounded-lg px-4 py-3 w-full max-w-xs mx-auto bg-bg">
      <button
        onClick={() => setOpen(false)}
        className="absolute top-1.5 right-2 text-muted hover:text-fg text-[0.8rem] cursor-pointer leading-none"
        aria-label="Close"
      >
        ✕
      </button>

      {status === 'ok' ? (
        <p className="text-[0.8rem] text-emerald-400 text-center py-2">✓ Thanks, {name} — your tier is recorded.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <p className="text-[0.65rem] font-bold uppercase tracking-wider text-muted">
            Claim your reward tier
          </p>

          {/* Tier picker */}
          <label className="text-[0.72rem] text-muted">Tier</label>
          <select
            value={tierId}
            onChange={(e) => setTierId(e.target.value)}
            className="bg-transparent border border-muted/30 px-2 py-1 text-[0.75rem] text-fg rounded cursor-pointer"
          >
            {DONATION_TIERS.map((t) => (
              <option key={t.id} value={t.id} className="bg-bg">
                {t.name} &mdash; ${t.minUsdc} &mdash; {t.reward}
              </option>
            ))}
          </select>

          {/* Display name */}
          <label className="text-[0.72rem] text-muted">Your name (required)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alice"
            maxLength={60}
            className="bg-transparent border border-muted/30 px-2 py-1 text-[0.78rem] text-fg placeholder:text-muted/50"
            required
          />

          {/* Optional address */}
          <label className="text-[0.72rem] text-muted">Wallet address (optional)</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            maxLength={64}
            className="bg-transparent border border-muted/30 px-2 py-1 text-[0.75rem] text-fg placeholder:text-muted/50 font-mono"
          />

          {status === 'error' && (
            <p className="text-red-400 text-[0.72rem]">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === 'submitting' || !name.trim()}
            className="mt-1 bg-fg text-bg border border-fg px-3 py-1.5 text-[0.75rem] font-semibold hover:bg-bg hover:text-fg transition-colors disabled:opacity-40 cursor-pointer"
          >
            {status === 'submitting' ? 'Submitting…' : 'Claim tier'}
          </button>
        </form>
      )}
    </div>
  )
}
