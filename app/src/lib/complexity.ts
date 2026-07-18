/**
 * Estimates the implementation complexity of a proposal text.
 *
 * Three tiers — cheap / standard / complex — correspond to the model
 * intelligence cost the agent will use when implementing the feature:
 *
 *   cheap    → simple UI tweaks, text/label changes, minor config adjustments
 *   standard → new components, moderate logic changes, API wiring
 *   complex  → multi-file architecture, new infra, security-sensitive work
 *
 * This is a heuristic, client-side estimate meant for display only.
 * The actual model selection happens in the agent (AGENTS.md).
 */

export type ComplexityTier = 'cheap' | 'standard' | 'complex'

const COMPLEX_SIGNALS = [
  /\barchitect/i,
  /\bmigrat/i,
  /\bdatabase/i,
  /\binfrastructure/i,
  /\bsecurity/i,
  /\bauthentic/i,
  /\bencrypt/i,
  /\bsubagent/i,
  /\bmulti.?model/i,
  /\borchestrat/i,
  /\bwebsocket/i,
  /\breal.?time/i,
  /\bstreaming/i,
  /\bpayment/i,
  /\bwallet/i,
  /\bblockchain/i,
  /\bapi\s+integrat/i,
  /\bnew\s+service/i,
  /\bdeploy/i,
  /\brefactor.{0,30}(entire|whole|all)/i,
]

const CHEAP_SIGNALS = [
  /\bfix\s+(typo|color|spacing|font|margin|padding)/i,
  /\bchange\s+(text|label|title|color|font|style)/i,
  /\bupdate\s+(text|label|title|color|font|wording)/i,
  /\brename\b/i,
  /\btweak\b/i,
  /\bminor\b/i,
  /\bsmall\b/i,
  /\bsimple\b/i,
  /\bjust\s+(add|change|update|fix)\s+(a|the)\s+(text|word|label|color)/i,
  /\blink\b.*\bhref\b/i,
]

/**
 * Estimate the complexity tier of a proposal based on its text.
 * Pure — no side effects, no network.
 */
export function estimateComplexity(text: string): ComplexityTier {
  const lower = text.toLowerCase()
  const wordCount = text.trim().split(/\s+/).length

  // Explicit complex signals take priority
  if (COMPLEX_SIGNALS.some((re) => re.test(lower))) return 'complex'

  // Long proposals tend to be complex
  if (wordCount > 40) return 'complex'

  // Explicit cheap signals with short-to-medium text
  if (CHEAP_SIGNALS.some((re) => re.test(lower)) && wordCount < 20) return 'cheap'

  // Very short proposals without standard-feature language are cheap
  if (wordCount < 8) return 'cheap'

  return 'standard'
}

export const TIER_LABELS: Record<ComplexityTier, string> = {
  cheap: 'cheap',
  standard: 'standard',
  complex: 'complex',
}

export const TIER_TITLES: Record<ComplexityTier, string> = {
  cheap: 'Agent will use a fast, cheap model for this simple task',
  standard: 'Agent will use the standard model for this task',
  complex: 'Agent will use a powerful model and may spawn subagents for this complex task',
}
