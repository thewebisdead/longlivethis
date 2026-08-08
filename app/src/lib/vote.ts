import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { github, vote, publicUrl } from './config.ts'

// On-site voting, without a session store.
//
// A vote is still exactly what it was before: a 👍/👎 reaction on the proposal's
// GitHub issue. The only thing that changes is who POSTs it and from where —
// the visitor authorizes the proposals app, the app swaps their code for a user
// token, reacts AS THEM, and throws the token away in the same request. Nothing
// is written to disk, so there is no token store to steal and nothing to expire.
//
// The whole flow's state lives in the signed `state` parameter that rides
// through GitHub and back: it carries the issue number and the direction, so
// the callback can finish a vote it has no memory of starting. That signature
// is doing two jobs — keeping the flow stateless, and stopping someone from
// forging a vote a visitor never intended. Treat it as security-critical.
//
// A user token is capped by the intersection of the app's permissions and the
// user's own access, so this can never do more to the repo than the visitor
// already could by clicking the emoji on github.com themselves.

/** How long a started vote may take to come back through GitHub. */
const STATE_TTL_MS = 10 * 60_000

export type Direction = 'up' | 'down'

/** The 👍/👎 reaction each direction casts, and its opposite. */
const REACTION: Record<Direction, '+1' | '-1'> = { up: '+1', down: '-1' }

export interface VoteIntent {
  issue: number
  direction: Direction
}

interface StatePayload extends VoteIntent {
  /** Expiry (ms epoch). */
  e: number
  /** Nonce — makes each blob unique so two identical votes never collide. */
  n: string
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

function sign(body: string): string {
  return createHmac('sha256', vote.signingSecret).update(body).digest('base64url')
}

/** Signed, self-expiring blob carrying the vote across the GitHub round-trip. */
export function signState(intent: VoteIntent): string {
  const payload: StatePayload = {
    ...intent,
    e: Date.now() + STATE_TTL_MS,
    n: randomBytes(9).toString('base64url'),
  }
  const body = b64url(JSON.stringify(payload))
  return `${body}.${sign(body)}`
}

/**
 * Verify and unpack a `state` blob. null on anything suspect — a bad signature
 * is an attempted forgery, not a recoverable error, so callers must not
 * distinguish the failure modes to whoever sent it.
 *
 * Replay is deliberately not defended against: re-running a valid state just
 * re-casts the same reaction, and GitHub is idempotent there (a repeat 👍
 * returns the existing one rather than adding a second). Defending it would
 * need exactly the store this design exists to avoid.
 */
export function verifyState(state: string | null): VoteIntent | null {
  if (!state) return null
  const [body, mac] = state.split('.')
  if (!body || !mac) return null

  // Constant-time, and length-checked first: timingSafeEqual throws on a length
  // mismatch, which would turn a malformed input into a 500.
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload
    if (typeof payload.e !== 'number' || Date.now() > payload.e) return null
    if (!Number.isInteger(payload.issue) || payload.issue <= 0) return null
    if (payload.direction !== 'up' && payload.direction !== 'down') return null
    return { issue: payload.issue, direction: payload.direction }
  } catch {
    return null
  }
}

/** Where GitHub sends the voter back. Must match the app's registered callback. */
export function callbackUrl(): string {
  return `${publicUrl}/api/vote/callback`
}

/**
 * The consent screen. GitHub Apps take no `scope` — a user token is bounded by
 * the app's own permissions, so there is nothing to ask for here.
 */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: vote.clientId,
    redirect_uri: callbackUrl(),
    state,
  })
  return `${vote.oauthBase}/login/oauth/authorize?${params}`
}

/** Redeem a single-use code for a user token (`ghu_…`). Never persisted. */
export async function exchangeCode(code: string): Promise<string> {
  const res = await fetch(`${vote.oauthBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: vote.clientId,
      client_secret: vote.clientSecret,
      code,
      redirect_uri: callbackUrl(),
    }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  // GitHub answers 200 with an `error` field on a bad or reused code.
  const body = (await res.json()) as { access_token?: string; error?: string }
  if (!body.access_token) throw new Error(`token exchange rejected: ${body.error ?? 'no token'}`)
  return body.access_token
}

async function api(path: string, token: string, init?: RequestInit): Promise<Response> {
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

/**
 * Cast the vote as the authenticated user, then clear their opposite reaction
 * if they had one.
 *
 * That second half is not cosmetic: votes are counted as 👍 minus 👎, and
 * GitHub is happy to let one account hold both at once. Without it, someone who
 * changes their mind lands on net zero instead of the −1 they just asked for.
 */
export async function castVote(token: string, { issue, direction }: VoteIntent): Promise<void> {
  const content = REACTION[direction]
  const base = `/repos/${github.repo}/issues/${issue}/reactions`

  const res = await api(base, token, { method: 'POST', body: JSON.stringify({ content }) })
  // 200 = the reaction was already there, 201 = newly added. Both are a
  // successful vote; only the pair is worth distinguishing from a real failure.
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`reaction failed: ${res.status}`)
  }

  await clearOpposite(token, base, content)
}

/** Best-effort removal of the voter's opposing reaction. */
async function clearOpposite(token: string, base: string, cast: '+1' | '-1'): Promise<void> {
  const opposite = cast === '+1' ? '-1' : '+1'
  try {
    const me = await api('/user', token)
    if (!me.ok) return
    const { login } = (await me.json()) as { login: string }

    const list = await api(`${base}?content=${encodeURIComponent(opposite)}&per_page=100`, token)
    if (!list.ok) return
    const reactions = (await list.json()) as Array<{ id: number; user: { login: string } | null }>
    const mine = reactions.find((r) => r.user?.login === login)
    if (mine) await api(`${base}/${mine.id}`, token, { method: 'DELETE' })
  } catch {
    // The vote itself already landed. Failing the request now would tell the
    // voter their vote did not count, which is worse than a stale opposite.
  }
}
