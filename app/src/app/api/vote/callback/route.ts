import { NextResponse } from 'next/server'
import { publicUrl, voteConfigured } from '@/lib/config'
import { castVote, exchangeCode, verifyState, type Direction } from '@/lib/vote'
import { refreshProposal } from '@/lib/github'

export const dynamic = 'force-dynamic'

// The other half of the vote. GitHub sends the visitor back here with a
// single-use code and the `state` blob we signed on the way out; that blob is
// the only record of what they were voting on, so it is verified before
// anything else happens.
//
// The user token obtained here lives for the duration of this request and is
// never written down — not to a cookie, not to disk, not to a log line.

/**
 * Back to the feed, with the outcome as query params for the UI to show.
 *
 * `issue` and `dir` ride along so the page can name what was voted on ("Vote
 * for #42 counted.") — the hash alone is not readable by a server render. They
 * are display-only and the page treats them as untrusted input, since anyone
 * can type this URL; nothing downstream reads a vote from them.
 *
 * PUBLIC_URL first, the request's own origin as the fallback: redirects have to
 * be absolute, and a deployment that never set PUBLIC_URL would otherwise send
 * its visitors to localhost. Preferring the configured value keeps the Host
 * header out of the decision wherever there is a configured value to use.
 */
function home(
  req: Request,
  status: 'ok' | 'denied' | 'failed',
  intent?: { issue: number; direction: Direction }
): NextResponse {
  const url = new URL(publicUrl || new URL(req.url).origin)
  url.searchParams.set('vote', status)
  if (intent) {
    url.searchParams.set('issue', String(intent.issue))
    url.searchParams.set('dir', intent.direction)
    url.hash = `p${intent.issue}`
  }
  return NextResponse.redirect(url, 302)
}

export async function GET(req: Request) {
  if (!voteConfigured) return home(req, 'failed')

  const params = new URL(req.url).searchParams

  // The visitor declined on the consent screen — expected, not an error.
  if (params.get('error')) return home(req, 'denied')

  // Verified before the code is spent: an unsigned or expired state means we
  // cannot know what this vote was for, and redeeming the code first would burn
  // it for nothing. A forged state and an expired one are answered identically.
  const intent = verifyState(params.get('state'))
  const code = params.get('code')
  if (!intent || !code) return home(req, 'failed')

  try {
    const token = await exchangeCode(code)
    await castVote(token, intent)
    await refreshProposal(intent.issue)
    return home(req, 'ok', intent)
  } catch (err) {
    // Deliberately terse to the visitor: the detail here (bad code, revoked
    // install, GitHub outage) is operator information, not theirs.
    console.error('vote callback failed:', err)
    return home(req, 'failed', intent)
  }
}
