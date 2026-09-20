// The one place the app reads its environment.
//
// These values are per-deployment, not source constants: they are written to
// /etc/longlive/app.env when the box is provisioned, and change (wallet
// rotation, VPS migration, repo rename) without a code change. Keeping
// WALLET_ADDRESS out of source also matters — `app/` is agent-editable,
// app.env is not, so a PR touching the app cannot retarget the treasury.
//
// Read once at module load: app.env is only re-read when the container
// restarts, which is exactly when these can change.

/** Trimmed env value, or '' when unset. */
function str(name: string): string {
  return process.env[name]?.trim() ?? ''
}

/** Trimmed env value with trailing slashes stripped, or '' when unset. */
function url(name: string): string {
  return str(name).replace(/\/+$/, '')
}

/** Repo the app links to (Constitution / About / GitHub). null when unset. */
export const repoUrl: string | null = url('REPO_URL') || null

/** Public treasury address. Receive-only — the app never holds a spend key. */
export const walletAddress: string = str('WALLET_ADDRESS')

/** Base JSON-RPC endpoint for the USDC balance read. */
export const baseRpcUrl: string = url('BASE_RPC_URL') || 'https://mainnet.base.org'

/**
 * GitHub App credentials backing the proposal store (Issues on this repo).
 *
 * These belong to the PROPOSALS app — Issues:write + Actions:write, and
 * nothing else. It is a different app from the one agent.yml uses (which holds
 * Contents/Pull-requests write and whose key never leaves GitHub Secrets).
 * That split is deliberate: this file is agent-editable and the key it reads
 * sits on the VPS, so assume anything reachable here is reachable by whatever
 * merges next. Do not widen this app's permissions.
 *
 * `apiBase` points at a stub API and `token` is a static-PAT fallback, both
 * for preview and stubbed-CI environments that cannot mint app tokens.
 */
export const github = {
  apiBase: url('GITHUB_API_BASE') || 'https://api.github.com',
  repo: str('GITHUB_REPO'),
  token: str('GITHUB_TOKEN'),
  appId: str('GITHUB_APP_ID'),
  // env_file lines cannot hold a multiline PEM, so the key arrives base64.
  appPrivateKey: str('GITHUB_APP_PRIVATE_KEY_B64')
    ? Buffer.from(str('GITHUB_APP_PRIVATE_KEY_B64'), 'base64').toString('utf8')
    : '',
  appInstallationId: str('GITHUB_APP_INSTALLATION_ID'),
  appSlug: str('GITHUB_APP_SLUG'),
} as const

/** True when app-token minting is possible; otherwise the PAT fallback applies. */
export const githubAppConfigured: boolean = Boolean(
  github.appId && github.appPrivateKey && github.appInstallationId
)

/**
 * Model policy — which model tier each agent run should use (modelPolicy.ts).
 *
 * The app never runs inference itself, so these ids are *recommendations* the
 * dispatcher records and surfaces: routine / maintenance runs should use the
 * cheapest capable model, and complex implementation runs should keep the
 * expensive one. They are read from the VPS app.env (CHEAP_MODEL /
 * COMPLEX_MODEL), with a conservative default for the complex model so the
 * code path is live from first boot. They are also the values a maintainer
 * should align with the frozen INFERENCE_MODEL / GATE_MODEL repo variables —
 * this is the app-side expression of that same split.
 */
export const modelPolicyConfig: {
  complexModel: string
  cheapModel: string | null
  complexFromEnv: boolean
  cheapFromEnv: boolean
} = (() => {
  const complex = str('COMPLEX_MODEL') || 'anthropic/claude-sonnet-5'
  const cheap = str('CHEAP_MODEL') || null
  return {
    complexModel: complex,
    cheapModel: cheap && cheap !== complex ? cheap : null,
    complexFromEnv: Boolean(str('COMPLEX_MODEL')),
    // A CHEAP_MODEL equal to the complex model is not a real lean tier — treat
    // it as unconfigured so we never claim a saving that does not exist.
    cheapFromEnv: Boolean(str('CHEAP_MODEL')) && str('CHEAP_MODEL') !== complex,
  }
})()

/**
 * Emergency Survival Mode threshold, in runway days. When projected runway
 * drops at or below this, the app enters emergency mode: it reduces
 * unnecessary AI executions and prioritizes cost-saving / revenue-generating
 * proposals. Configurable via the EMERGENCY_THRESHOLD_DAYS env var (defaults
 * to 30, matching the existing "reduced" runway level).
 */
export const emergencyThresholdDays: number = (() => {
  const raw = str('EMERGENCY_THRESHOLD_DAYS')
  if (!raw) return 30
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 30
  return n
})()

/** Public origin of this deployment — the OAuth redirect must be absolute. */
export const publicUrl: string = url('PUBLIC_URL')

/**
 * On-site voting via the proposals app's user-to-server OAuth.
 *
 * A visitor authorizes, the app swaps their code for a user token, POSTs the
 * reaction AS THEM, and discards the token before the response — nothing is
 * persisted, so there is no token store to leak. Votes are still 👍/👎
 * reactions on the issue, so nothing downstream (counting, the agent's
 * selection) learns a new source of truth.
 *
 * `oauthBase` is github.com, NOT api.github.com — the authorize and token
 * endpoints live on the web host. Overridable for the same reason `apiBase`
 * is: preview and stubbed-CI environments point both at a fake.
 *
 * `signingSecret` keys the HMAC over the `state` blob that carries the issue
 * number and direction across the round-trip. It is what makes the flow
 * stateless AND what stops a forged vote, so it must not be reused elsewhere.
 */
export const vote = {
  oauthBase: url('GITHUB_OAUTH_BASE') || 'https://github.com',
  clientId: str('GITHUB_OAUTH_CLIENT_ID'),
  clientSecret: str('GITHUB_OAUTH_CLIENT_SECRET'),
  signingSecret: str('VOTE_SIGNING_SECRET'),
} as const

/**
 * Can visitors vote without leaving the site? False on deployments provisioned
 * before OAuth existed (their client secret is unrecoverable), and in preview —
 * the feed then links to the issue on GitHub, which is where voting used to
 * happen exclusively. Every vote route checks this before doing anything.
 */
export const voteConfigured: boolean = Boolean(
  vote.clientId && vote.clientSecret && vote.signingSecret && publicUrl
)
