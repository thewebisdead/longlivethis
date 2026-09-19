/**
 * Donation tier definitions — pure values, no I/O.
 *
 * Separated from the store logic so client components can import the tier
 * definitions without bundling node:fs/promises.
 */

/**
 * How recognisable a tier's reward is. Badge = a small mark on the supported
 * strip. Thanks = a named thank-you line. Sponsor = a named slot ("supported
 * by YOU"), the strong version of a sponsor slot. Founder = permanent top
 * billing on the homepage.
 */
export type TierRecognition = 'badge' | 'thanks' | 'sponsor' | 'founder'

export interface DonationTier {
  /** Stable id (alphanumeric slug). */
  id: string
  /** Display name, e.g. "Supporter". */
  name: string
  /** Minimum donation to unlock this tier, in USDC. */
  minUsdc: number
  /** What the supporter gets back, phrased for the menu. */
  reward: string
  /** How recognisable the reward is — drives how it renders on the homepage. */
  recognition: TierRecognition
}

/**
 * The tier ladder, low to high. These are source constants — the app's honest
 * pricing of its own survival. Thresholds are round numbers that stay
 * reachable for individuals while still moving the runway at the top end.
 */
export const DONATION_TIERS: DonationTier[] = [
  {
    id: 'supporter',
    name: 'Supporter',
    minUsdc: 5,
    reward: 'A named thank-you line on the homepage ledger.',
    recognition: 'badge',
  },
  {
    id: 'friend',
    name: 'Friend',
    minUsdc: 20,
    reward: 'A public friend badge on the home badge strip + thank-you line.',
    recognition: 'badge',
  },
  {
    id: 'patron',
    name: 'Patron',
    minUsdc: 50,
    reward: 'A named sponsor slot on the homepage\u2019s \u201csupported by\u201d strip for a funding cycle.',
    recognition: 'sponsor',
  },
  {
    id: 'guardian',
    name: 'Guardian',
    minUsdc: 100,
    reward: 'A featured sponsor slot on the homepage and a line in the README acknowledgements.',
    recognition: 'sponsor',
  },
  {
    id: 'founder',
    name: 'Founder',
    minUsdc: 250,
    reward: 'Permanent top billing as a founding supporter on the homepage and README.',
    recognition: 'founder',
  },
]

/** The highest tier a given USDC amount unlocks. Pure. */
export function tierForAmount(usdc: number): DonationTier {
  let best = DONATION_TIERS[0]
  for (const t of DONATION_TIERS) {
    if (usdc >= t.minUsdc) best = t
  }
  return best
}

/** Whether an amount has reached or passed a specific tier. Pure. */
export function reachesTier(usdc: number, tierId: string): boolean {
  const tier = DONATION_TIERS.find((t) => t.id === tierId)
  if (!tier) return false
  return usdc >= tier.minUsdc
}
