import { NextResponse } from 'next/server'
import { github, voteConfigured } from '@/lib/config'
import { authorizeUrl, signState, type Direction } from '@/lib/vote'

export const dynamic = 'force-dynamic'

// Start of a vote: sign the intent, hand the visitor to GitHub's consent
// screen. GET rather than POST because the feed links here — a plain <a> works
// without JavaScript, and the request is a redirect, not a state change (the
// reaction is only cast in the callback, after GitHub authenticates the user).

/** Fall back to the issue on GitHub — where voting worked before this route. */
function issueUrl(issue: number): string {
  return `https://github.com/${github.repo}/issues/${issue}`
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const issue = Number(params.get('issue'))
  const direction = params.get('dir')

  if (!Number.isInteger(issue) || issue <= 0) {
    return NextResponse.json({ error: 'issue required' }, { status: 400 })
  }
  if (direction !== 'up' && direction !== 'down') {
    return NextResponse.json({ error: 'dir must be up or down' }, { status: 400 })
  }

  // Not configured (older deployments, preview, CI): send them to GitHub to
  // react by hand rather than 500. The vote still counts — it is the same
  // reaction on the same issue, just one more click away.
  if (!voteConfigured) return NextResponse.redirect(issueUrl(issue), 302)

  const state = signState({ issue, direction: direction as Direction })
  return NextResponse.redirect(authorizeUrl(state), 302)
}
