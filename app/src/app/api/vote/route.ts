import { NextResponse } from 'next/server'
import { github, voteConfigured } from '@/lib/config'
import { authorizeUrl, sameOrigin, signState, type Direction } from '@/lib/vote'

export const dynamic = 'force-dynamic'

// Start of a vote: sign the intent, hand the visitor to GitHub's consent
// screen.
//
// POST, not GET, and deliberately so. For a visitor who is signed in to GitHub
// and has already authorized this app, the consent screen auto-approves — so
// merely REACHING this route is enough to cast a vote in their name. As a GET
// that meant any page anywhere could vote for them by linking or redirecting
// here. A POST cannot be provoked by a link, an <img>, or a redirect, and the
// same-origin check below rejects the cross-site form that could.
//
// The cost is that the feed submits a form rather than rendering an <a>; the
// flow is still plain navigation with no client JavaScript.

/** Fall back to the issue on GitHub — where voting worked before this route. */
function issueUrl(issue: number): string {
  return `https://github.com/${github.repo}/issues/${issue}`
}

export async function POST(req: Request) {
  // Answered before the body is even read: a cross-site request has nothing to
  // say here, and it is not the visitor's error to explain.
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'cross-site vote rejected' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'form body required' }, { status: 400 })
  }
  const issue = Number(form.get('issue'))
  const direction = form.get('dir')

  if (!Number.isInteger(issue) || issue <= 0) {
    return NextResponse.json({ error: 'issue required' }, { status: 400 })
  }
  if (direction !== 'up' && direction !== 'down') {
    return NextResponse.json({ error: 'dir must be up or down' }, { status: 400 })
  }

  // Not configured (older deployments, preview, CI): send them to GitHub to
  // react by hand rather than 500. The vote still counts — it is the same
  // reaction on the same issue, just one more click away.
  //
  // 303 on both redirects, not 302: the browser must follow them with a GET.
  if (!voteConfigured) return NextResponse.redirect(issueUrl(issue), 303)

  const state = signState({ issue, direction: direction as Direction })
  return NextResponse.redirect(authorizeUrl(state), 303)
}
