import { createSign } from 'crypto'
import type { Proposal } from './types'

// Proposals live in GitHub Issues — there is no database. The app creates an
// issue per proposal as a GitHub App (installed on this repo only, Issues
// read/write; never a spend key), minting short-lived installation tokens
// from GITHUB_APP_* env vars. The feed lists issues created by the app's bot
// identity; votes are the issue's 👍/👎 reactions (👍 counts for, 👎 counts
// against, every other emoji is ignored). Comments and issues from anyone
// else are ignored.
//
// A static GITHUB_TOKEN (with GET /user identity) is kept as a fallback so
// CI (scripts/locked/smoke.sh) and local preview can run against a stub.
// GITHUB_API_BASE exists so CI can point the app at that stub.

const API_BASE = (process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/$/, '')
const REPO = process.env.GITHUB_REPO ?? ''
const STATIC_TOKEN = process.env.GITHUB_TOKEN ?? ''
const APP_ID = process.env.GITHUB_APP_ID ?? ''
const APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY_B64
  ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8')
  : ''
const APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID ?? ''
const APP_SLUG = process.env.GITHUB_APP_SLUG ?? ''
const APP_CONFIGURED = Boolean(APP_ID && APP_PRIVATE_KEY && APP_INSTALLATION_ID)

const CACHE_TTL_MS = 60_000
const TITLE_MAX = 80 // GitHub caps titles at 256; keep them scannable

// Next bundles this module separately for the page and each API route, so
// module-level state is NOT shared between them. Caches live on globalThis
// (one Node process) so a POSTed proposal is visible to the page render
// immediately.
interface GhCaches {
  token: { token: string; expiresAt: number } | null
  list: { data: Proposal[]; ts: number } | null
  listInflight: Promise<Proposal[]> | null
  login: Promise<string> | null
}
const caches = ((globalThis as Record<string, unknown>).__longliveGh ??= {
  token: null,
  list: null,
  listInflight: null,
  login: null,
}) as GhCaches

export const SPONSORED_LABEL = 'boosted'
/** Pattern stored in issue body to track cumulative boost amount */
const BOOST_TOTAL_RE = /<!--\s*boost_total:\s*([0-9]+(?:\.[0-9]+)?)\s*-->/
/** Pattern stored in issue body to record all used tx hashes (newline-separated inside the comment) */
const USED_TX_RE = /<!--\s*used_tx:([\s\S]*?)-->/

/** Parse the set of already-used tx hashes from an issue body. Pure. */
export function parseUsedTxHashes(body: string | null | undefined): Set<string> {
  if (!body) return new Set()
  const m = body.match(USED_TX_RE)
  if (!m) return new Set()
  return new Set(m[1].split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean))
}

/** Produce updated body with the tx hash appended to the used-tx list. Pure. */
export function addUsedTxHash(body: string | null | undefined, txHash: string): string {
  const existing = parseUsedTxHashes(body)
  existing.add(txHash.toLowerCase())
  const list = Array.from(existing).join('\n')
  const comment = `<!-- used_tx:\n${list}\n-->`
  const base = body ?? ''
  if (USED_TX_RE.test(base)) {
    return base.replace(USED_TX_RE, comment)
  }
  return `${base.trimEnd()}\n${comment}`
}

export interface GhIssue {
  number: number
  title: string
  body?: string | null
  html_url: string
  created_at: string
  /** Present when the "issue" is actually a pull request — always skipped. */
  pull_request?: unknown
  reactions?: { '+1'?: number; '-1'?: number }
  labels?: Array<{ name: string }>
}

/** Parse cumulative boost total from an issue body HTML comment. Pure. */
export function parseBoostTotal(body: string | null | undefined): number {
  if (!body) return 0
  const m = body.match(BOOST_TOTAL_RE)
  return m ? parseFloat(m[1]) : 0
}

/** Produce updated body with new boost total stored in HTML comment. Pure. */
export function setBoostTotal(body: string | null | undefined, total: number): string {
  const comment = `<!-- boost_total: ${total.toFixed(6)} -->`
  const existing = (body ?? '').match(BOOST_TOTAL_RE)
  if (existing) {
    return (body ?? '').replace(BOOST_TOTAL_RE, comment)
  }
  return `${(body ?? '').trimEnd()}\n${comment}`
}

/** Issue → Proposal. Pure — unit-tested without network. */
export function mapIssue(issue: GhIssue): Proposal {
  // Net votes: 👍 minus 👎; every other emoji is ignored.
  const r = issue.reactions
  const boostTotal = parseBoostTotal(issue.body)
  return {
    id: issue.number,
    text: (issue.body?.replace(BOOST_TOTAL_RE, '').replace(USED_TX_RE, '').trim()) || issue.title,
    votes: (r?.['+1'] ?? 0) - (r?.['-1'] ?? 0),
    url: issue.html_url,
    created_at: issue.created_at,
    boosted: issue.labels?.some((l) => l.name === SPONSORED_LABEL) ?? false,
    boostTotal,
  }
}

/** Normalization used for duplicate detection. Pure. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Single-line issue title from a proposal (full text goes in the body). Pure. */
export function issueTitle(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** Short-lived app JWT (RS256, no deps) — authenticates as the app itself. */
function appJwt(): string {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: APP_ID })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(APP_PRIVATE_KEY, 'base64url')
  return `${unsigned}.${signature}`
}

// Installation tokens expire after 1 h — cache and re-mint 5 min before expiry.
async function installationToken(): Promise<string> {
  if (caches.token && Date.now() < caches.token.expiresAt - 5 * 60_000) return caches.token.token
  const res = await fetch(`${API_BASE}/app/installations/${APP_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status}`)
  const { token, expires_at } = (await res.json()) as { token: string; expires_at: string }
  caches.token = { token, expiresAt: Date.parse(expires_at) }
  return token
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  if ((!APP_CONFIGURED && !STATIC_TOKEN) || !REPO) {
    throw new Error('GITHUB_APP_* / GITHUB_TOKEN / GITHUB_REPO not configured')
  }
  const token = APP_CONFIGURED ? await installationToken() : STATIC_TOKEN
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  })
}

// The identity that authors proposal issues — issues by anyone else are not
// proposals. App tokens cannot call GET /user; the bot login is derived from
// the app slug. The static-token fallback resolves it via GET /user once.
function appLogin(): Promise<string> {
  if (APP_CONFIGURED && APP_SLUG) return Promise.resolve(`${APP_SLUG}[bot]`)
  caches.login ??= gh('/user').then(async (res) => {
    if (!res.ok) {
      caches.login = null
      throw new Error(`GitHub /user failed: ${res.status}`)
    }
    return ((await res.json()) as { login: string }).login
  })
  return caches.login
}

// GitHub rate limit is 5000 req/h for a PAT; every feed view must not hit it.
export async function listProposals(): Promise<Proposal[]> {
  if (caches.list && Date.now() - caches.list.ts < CACHE_TTL_MS) return caches.list.data
  // Coalesce concurrent misses: one GitHub call per expiry, not one per request.
  caches.listInflight ??= (async () => {
    const login = await appLogin()
    const path = `/repos/${REPO}/issues?creator=${encodeURIComponent(login)}&state=open&per_page=100&sort=created&direction=desc`
    let res = await gh(path)
    if (res.status >= 500) {
      // GitHub 503s in bursts during incidents — one quick retry often lands.
      await new Promise((r) => setTimeout(r, 500))
      res = await gh(path)
    }
    if (!res.ok) throw new Error(`GitHub list issues failed: ${res.status}`)
    const issues = (await res.json()) as GhIssue[]
    const data = issues.filter((i) => !i.pull_request).map(mapIssue)
    caches.list = { data, ts: Date.now() }
    return data
  })()
    .catch((err) => {
      // A GitHub blip must not blank the feed: serve the last good list and
      // try again after the normal TTL. Only fail when there is nothing to serve.
      if (caches.list) {
        console.error('proposal list refresh failed — serving stale:', err)
        caches.list.ts = Date.now()
        return caches.list.data
      }
      throw err
    })
    .finally(() => {
      caches.listInflight = null
    })
  return caches.listInflight
}

export async function createProposal(text: string): Promise<Proposal> {
  const res = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: issueTitle(text), body: text }),
  })
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message
    throw new Error(detail ? `GitHub: ${detail}` : `GitHub create issue failed: ${res.status}`)
  }
  const proposal = mapIssue((await res.json()) as GhIssue)
  // GitHub's list endpoint is eventually consistent — a just-created issue can
  // be missing from it for a while. Seed the cache with the new proposal
  // instead of invalidating, so the feed shows it immediately.
  if (caches.list) caches.list = { data: [proposal, ...caches.list.data], ts: Date.now() }
  return proposal
}

/**
 * Ensure the repo-level "boosted" label exists (creates it if missing).
 * Safe to call concurrently — GitHub 422 on duplicate is swallowed.
 */
async function ensureSponsoredLabel(): Promise<void> {
  const res = await gh(`/repos/${REPO}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: SPONSORED_LABEL, color: 'f9d71c', description: 'Boosted proposal — floated to the top of the feed' }),
  })
  // 422 = already exists; both are fine
  if (!res.ok && res.status !== 422) {
    throw new Error(`GitHub create label failed: ${res.status}`)
  }
}

/**
 * Add the "boosted" label to the given issue and record the cumulative boost
 * total in the issue body. Supports repeated boosts — each call adds to the
 * running total.
 * txHash is required to prevent replay attacks (same tx used multiple times).
 */
export async function sponsorProposal(issueNumber: number, amount: number, txHash: string): Promise<void> {
  await ensureSponsoredLabel()

  // Fetch the current issue body to read/update the running boost total.
  const issueRes = await gh(`/repos/${REPO}/issues/${issueNumber}`)
  if (!issueRes.ok) throw new Error(`GitHub get issue failed: ${issueRes.status}`)
  const issue = (await issueRes.json()) as GhIssue

  // Reject if this tx hash was already used on this proposal.
  const usedHere = parseUsedTxHashes(issue.body)
  if (usedHere.has(txHash.toLowerCase())) {
    throw new Error('transaction hash has already been used to boost this proposal')
  }

  // Also reject if this tx hash was used on any other proposal (cross-proposal replay).
  const allProposals = await listProposals()
  for (const proposal of allProposals) {
    if (proposal.id === issueNumber) continue
    // We need the full issue body for each proposal; listProposals caches bodies.
    // Re-fetch from cache is fine — in the worst case we miss a very recent boost
    // on another issue, but the per-issue check above is the strong guard.
    // For cross-proposal protection we search the cached data which includes body
    // stored in the used_tx comment indirectly. But listProposals only returns
    // Proposal objects without raw bodies. We'll fetch the raw issue to be sure.
    const otherRes = await gh(`/repos/${REPO}/issues/${proposal.id}`)
    if (!otherRes.ok) continue
    const otherIssue = (await otherRes.json()) as GhIssue
    const usedThere = parseUsedTxHashes(otherIssue.body)
    if (usedThere.has(txHash.toLowerCase())) {
      throw new Error('transaction hash has already been used to boost another proposal')
    }
  }

  const prevTotal = parseBoostTotal(issue.body)
  const newTotal = prevTotal + amount
  // Update body: set new boost total AND record the used tx hash.
  let newBody = setBoostTotal(issue.body, newTotal)
  newBody = addUsedTxHash(newBody, txHash)

  // Update the issue body with the new total.
  const patchRes = await gh(`/repos/${REPO}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: newBody }),
  })
  if (!patchRes.ok) {
    const detail = ((await patchRes.json().catch(() => null)) as { message?: string } | null)?.message
    throw new Error(detail ? `GitHub: ${detail}` : `GitHub update issue failed: ${patchRes.status}`)
  }

  // Ensure the boosted label is applied (idempotent).
  const labelRes = await gh(`/repos/${REPO}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [SPONSORED_LABEL] }),
  })
  if (!labelRes.ok && labelRes.status !== 422) {
    const detail = ((await labelRes.json().catch(() => null)) as { message?: string } | null)?.message
    throw new Error(detail ? `GitHub: ${detail}` : `GitHub add label failed: ${labelRes.status}`)
  }

  // Update in-memory cache
  if (caches.list) {
    caches.list = {
      data: caches.list.data.map((p) =>
        p.id === issueNumber ? { ...p, boosted: true, boostTotal: newTotal } : p
      ),
      ts: caches.list.ts,
    }
  }
}
