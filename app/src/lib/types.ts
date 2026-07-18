import type { ComplexityTier } from './complexity'

export interface Proposal {
  /** GitHub issue number */
  id: number
  text: string
  /** Net 👍/👎 reactions on the issue: 👍 +1, 👎 −1, other emojis ignored */
  votes: number
  /** GitHub issue URL — where voting (reacting) happens */
  url: string
  created_at: string
  /** Whether the proposal has been boosted (floats to top of feed) */
  boosted?: boolean
  /** Total USDC boosted for this proposal (sum of all boosts) */
  boostTotal?: number
  /**
   * Estimated implementation cost tier for the agent.
   * Derived client-side from the proposal text — not stored in GitHub.
   */
  complexity?: ComplexityTier
}
