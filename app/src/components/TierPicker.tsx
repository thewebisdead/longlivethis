'use client'

import { useState } from 'react'
import { donateUri } from '@/lib/donation'
import { DONATION_TIERS, tierForAmount } from '@/lib/donationTiers.common'

interface TierPickerProps {
  walletAddress: string
}

/**
 * Interactive donation tier selector.
 *
 * A supporter picks an amount — either a fixed tier chip or their own custom
 * number — and instantly sees what reward that unlocks (tier name + reward).
 * The donate link opens the wallet with the picked amount pre-filled. Tiered
 * amounts sit above a plain $1 floor so the ladder never removes the ability
 * to give whatever a visitor chooses.
 */
export default function TierPicker({ walletAddress }: TierPickerProps) {
  const [selectedUsdc, setSelectedUsdc] = useState(1)
  const [custom, setCustom] = useState('')

  // Tier chips: a $1 baseline + each tier's min amount (deduped, ordered).
  const amounts = [1, ...DONATION_TIERS.map((t) => t.minUsdc)]
  const distinctAmounts = [...new Set(amounts)].sort((a, b) => a - b)

  const tier = tierForAmount(selectedUsdc)
  const uri = donateUri(walletAddress, selectedUsdc)

  function choose(amt: number) {
    setSelectedUsdc(amt)
    setCustom('')
  }

  function onCustom(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setCustom(raw)
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) {
      setSelectedUsdc(Math.max(1, Math.round(n * 100) / 100))
    }
  }

  return (
    <div className="mt-2 flex flex-col items-center gap-2">
      {/* Tier amount selector — clickable chips + custom */}
      <div className="flex flex-wrap gap-1.5 justify-center">
        {distinctAmounts.map((amt) => (
          <button
            key={amt}
            onClick={() => choose(amt)}
            className={`px-3 py-1 text-[0.75rem] font-semibold border cursor-pointer transition-colors ${
              selectedUsdc === amt && custom === ''
                ? 'bg-fg text-bg border-fg'
                : 'bg-transparent text-muted border-muted/40 hover:border-fg hover:text-fg'
            }`}
          >
            ${amt}
          </button>
        ))}
        <input
          type="number"
          min="1"
          step="0.01"
          value={custom}
          onChange={onCustom}
          placeholder="custom"
          className="w-24 bg-transparent border border-muted/40 px-2 py-1 text-[0.75rem] text-fg placeholder:text-muted/50 text-center"
        />
      </div>

      {/* Show what the selected amount unlocks */}
      <div className="text-[0.72rem] text-center">
        {selectedUsdc >= tier.minUsdc && selectedUsdc >= DONATION_TIERS[0].minUsdc ? (
          <>
            <span className="text-muted">unlocks the </span>
            <span className="text-fg font-semibold">{tier.name}</span>
            <span className="text-muted"> tier — </span>
            <span className="text-fg">{tier.reward}</span>
          </>
        ) : (
          <span className="text-muted">
            tip — no tier, but it still helps the treasury
          </span>
        )}
      </div>

      {/* Deep-link to pre-fill the picked amount */}
      <div className="flex flex-wrap items-center gap-2 justify-center">
        <a
          href={uri}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 border border-fg px-3 py-1.5 text-[0.8rem] font-semibold text-fg no-underline hover:bg-fg hover:text-bg"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4" aria-hidden="true">
            <path d="M12 2v20M17 7l-5-5-5 5M7 17l5 5 5-5" />
          </svg>
          Donate ${selectedUsdc.toFixed(2).replace(/\.00$/, '')} USDC
        </a>
      </div>
    </div>
  )
}
