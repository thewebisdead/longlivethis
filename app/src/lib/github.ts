import { createSign } from 'crypto'
import { github, githubAppConfigured } from './config.ts'
import { defineCache } from './cache.ts'
import type { Proposal } from './types'

// Proposals live in GitHub Issues — there is no database. The app creates an
// issue per proposal as the PROPOSALS GitHub App (installed on this repo only,
// Issues + Actions write; no repo-write and never a spend key), minting
// short-lived installation tokens from the credentials in `config`. The agent
// that implements proposals authenticates as a SEPARATE app whose key is not
// on this box — see config.ts. The feed lists issues created by the proposals
// bot identity; votes are the issue's 👍/👎 reactions (👍 counts for, 👎 counts
// against, every other emoji is ignored). Comments and issues from anyone else
// are ignored.
//
// A static token (with GET /user identity) is kept as a fallback so preview
// and stubbed-CI environments can run the app without minting app tokens, and
// `github.apiBase` points them at a stub GitHub API. All of it comes from
// ./config — this module never reads process.env itself.

const TITLE_MAX = 80 // GitHub caps titles at 256; keep them scannable

// Next bundles this module separately for the page and each API route, so
// module-level state is NOT shared between them. These live on globalThis (one
// Node process) so a POSTed proposal is visible to the page render immediately.
//
// The proposal list itself is a defineCache (below) — it needs the TTL,
// coalescing and stale-on-error that helper provides. These two do not: the
// installation token carries its own server-issued expiry rather than a TTL,
// and the bot login never changes for the life of the process.
interface GhCaches {
  token: { token: string; expiresAt: number } | null
  login: Promise<string> | null
}
const caches = ((globalThis as Record<string, unknown>).__longliveGh ??= {
  token: null,
  login: null,
}) as GhCaches

export interface GhIssue {
  number: number
  title: string
  body?: string | null
  html_url: string
  created_at: string
  /** Present when the "issue" is actually a pull request — always skipped. */
  pull_request?: unknown
  reactions?: { '+1'?: number; '-1'?: number }
}

/** Issue → Proposal. Pure — unit-tested without network. */
export function mapIssue(issue: GhIssue): Proposal {
  // Net votes: 👍 minus 👎; every other emoji is ignored.
  const r = issue.reactions
  return {
    id: issue.number,
    title: issue.title,
    text: issue.body?.trim() || issue.title,
    votes: (r?.['+1'] ?? 0) - (r?.['-1'] ?? 0),
    url: issue.html_url,
    created_at: issue.created_at,
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
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: github.appId })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(github.appPrivateKey, 'base64url')
  return `${unsigned}.${signature}`
}

// Installation tokens expire after 1 h — cache and re-mint 5 min before expiry.
async function installationToken(): Promise<string> {
  if (caches.token && Date.now() < caches.token.expiresAt - 5 * 60_000) return caches.token.token
  const url = `${github.apiBase}/app/installations/${github.appInstallationId}/access_tokens`
  const res = await fetch(url, {
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
  if ((!githubAppConfigured && !github.token) || !github.repo) {
    throw new Error('GITHUB_APP_* / GITHUB_TOKEN / GITHUB_REPO not configured')
  }
  const token = githubAppConfigured ? await installationToken() : github.token
  return fetch(`${github.apiBase}${path}`, {
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
  if (githubAppConfigured && github.appSlug) return Promise.resolve(`${github.appSlug}[bot]`)
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
// serveStaleOnError: a GitHub blip must not blank the feed — the last good list
// is served and the refresh retried after the normal TTL. Only a cold cache
// with a failing upstream propagates the error.
const listCache = defineCache('proposals', 60_000, fetchProposals, { serveStaleOnError: true })

async function fetchProposals(): Promise<Proposal[]> {
  const login = await appLogin()
  const path = `/repos/${github.repo}/issues?creator=${encodeURIComponent(login)}&state=open&per_page=100&sort=created&direction=desc`
  let res = await gh(path)
  if (res.status >= 500) {
    // GitHub 503s in bursts during incidents — one quick retry often lands.
    await new Promise((r) => setTimeout(r, 500))
    res = await gh(path)
  }
  if (!res.ok) throw new Error(`GitHub list issues failed: ${res.status}`)
  const issues = (await res.json()) as GhIssue[]
  return issues.filter((i) => !i.pull_request).map(mapIssue)
}

export function listProposals(): Promise<Proposal[]> {
  return listCache.get()
}

/**
 * Re-read one issue and update it in the cached list, after a vote changed its
 * reaction counts. Without this the voter is redirected back to a list that can
 * be up to the cache TTL stale — their vote appears not to have registered.
 *
 * One issue rather than the whole list: it is a single request, and the count
 * that just changed is the only one that can be wrong. Best-effort — the vote
 * is already recorded on GitHub, so a failure here costs freshness, not a vote.
 */
export async function refreshProposal(issue: number): Promise<void> {
  try {
    const cached = listCache.peek()
    if (!cached) return
    const res = await gh(`/repos/${github.repo}/issues/${issue}`)
    if (!res.ok) return
    const updated = mapIssue((await res.json()) as GhIssue)
    listCache.set(cached.map((p) => (p.id === updated.id ? updated : p)))
  } catch {
    // Stale counts only; the next TTL expiry corrects them.
  }
}

export async function createProposal(text: string): Promise<Proposal> {
  const res = await gh(`/repos/${github.repo}/issues`, {
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
  // instead of invalidating, so the feed shows it immediately. peek() rather
  // than get(): if nothing is cached there is no list to prepend to, and
  // loading one here would just race the same eventual consistency.
  const cached = listCache.peek()
  if (cached) listCache.set([proposal, ...cached])
  return proposal
}
