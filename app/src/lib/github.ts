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
