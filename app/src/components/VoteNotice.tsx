'use client'

import { useEffect } from 'react'

// The vote outcome travels back from the callback in the query string
// (?vote=ok&issue=42&dir=up) — that is how it survives a full-page redirect
// with no client state and no session store.
//
// It is reported as a plain alert() and nothing is rendered, so the feed keeps
// its layout the moment the voter dismisses it. The params are stripped on the
// way through: left in place they stay in the address bar, get copied into
// shared links, and re-alert on every reload. The #p<issue> hash stays, so the
// page remains scrolled to the proposal that was voted on.
//
// Stripping BEFORE the alert also makes this idempotent — React's dev-mode
// double-invoke re-runs the effect, finds no params, and returns without
// alerting twice.
//
// A visitor with JS disabled gets no notice at all. That is the accepted cost
// of an alert: the vote itself is already cast server-side by the time this
// page renders, so nothing is lost but the confirmation.
const VOTE_PARAMS = ['vote', 'issue', 'dir']

export default function VoteNotice({ message }: { message: string }) {
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!VOTE_PARAMS.some((p) => url.searchParams.has(p))) return
    for (const p of VOTE_PARAMS) url.searchParams.delete(p)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    window.alert(message)
  }, [message])

  return null
}
