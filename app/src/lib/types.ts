export type ProposalCategory = 'feature' | 'revenue' | 'cost-saving' | 'standard'

/**
 * What an expected benefit from a proposal is measured in: money the app
 * expects to earn, or money it expects to save on running costs.
 */
export type ProposalBenefitKind = 'revenue' | 'savings'

/**
 * Proposal economics — the proposer's estimate of what a feature will cost to
 * build and run, and what it is expected to return. Each figure is optional:
 * a small proposal may carry no economics at all, and a proposal filed on the
 * terminal (or by the agent) may omit them. All amounts are USDC, negative for
 * a cost and positive for a benefit. Kept as metadata so the feed can render
 * an "estimate vs actual" comparison once a proposal is implemented.
 */
export interface ProposalEconomics {
  /** One-time cost estimate to implement the proposal, USDC. */
  estimatedCostUsdc: number | null
  /** Recurring cost while the feature is live, USDC per funding cycle. */
  recurringCostUsdc: number | null
  /** Expected benefit per funding cycle once live: revenue or savings, USDC. */
  expectedBenefitUsdc: number | null
  /** Whether expectedBenefitUsdc is revenue or savings. */
  benefitKind: ProposalBenefitKind | null
  /** Estimated runway impact once live, days (positive = extends runway). */
  runwayImpactDays: number | null
}

export const EMPTY_ECONOMICS: ProposalEconomics = {
  estimatedCostUsdc: null,
  recurringCostUsdc: null,
  expectedBenefitUsdc: null,
  benefitKind: null,
  runwayImpactDays: null,
}

export interface Proposal {
  /** GitHub issue number */
  id: number
  /** Issue title — the single-line summary the feed renders. */
  title: string
  /** Issue body: the full proposal. Used for duplicate detection and by the agent. */
  text: string
  /** Net 👍/👎 reactions on the issue: 👍 +1, 👎 −1, other emojis ignored */
  votes: number
  /** GitHub issue URL — where voting (reacting) happens */
  url: string
  created_at: string
  /** Proposal category: feature, revenue, cost-saving, or standard (auto-detected). */
  category: ProposalCategory
  /** The proposer's economic estimate (cost / benefit / runway impact). */
  economics: ProposalEconomics
}
