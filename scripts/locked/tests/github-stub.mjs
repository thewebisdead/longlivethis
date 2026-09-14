#!/usr/bin/env node
// FROZEN at init — the stub GitHub API used by smoke.sh.
//
// Proposals live in GitHub Issues; the app talks to $GITHUB_API_BASE. This
// serves just enough of that API, in memory, for the smoke test to exercise
// proposal intake without a token and without creating real issues:
//   GET  /user                     → the app's identity check
//   GET  /repos/:owner/:repo/issues → list
//   POST /repos/:owner/:repo/issues → create (201)
//
// It also stands in for github.com ($GITHUB_OAUTH_BASE) so the on-site vote
// flow can be exercised end to end. Voting is a redirect chain through GitHub,
// so both halves have to exist for the smoke test to prove anything:
//   GET    /login/oauth/authorize    → auto-approves, redirects back with a code
//   POST   /login/oauth/access_token → the code exchange (rejects a bad code)
//   GET    /repos/:o/:r/issues/:n    → re-read after a vote
//   POST   /repos/:o/:r/issues/:n/reactions   → cast (201, or 200 if repeated)
//   GET    /repos/:o/:r/issues/:n/reactions   → find the voter's opposite
//   DELETE /repos/:o/:r/issues/:n/reactions/:id → clear it
//
// Everything else 404s. Port comes from $STUB_PORT (or argv[2]).
import http from 'node:http'

const port = Number(process.env.STUB_PORT || process.argv[2])
if (!port) {
  console.error('error: github-stub.mjs needs $STUB_PORT (or a port argument)')
  process.exit(1)
}

// The single-use code the authorize endpoint hands out. The exchange rejects
// anything else, so a callback reached with a forged code fails like the real
// thing rather than silently succeeding.
const CODE = 'stub-oauth-code'
// Who the user token belongs to. The installation token resolves to a
// different login, which is what makes "clear the voter's own opposite
// reaction" a meaningful test rather than a no-op.
const VOTER = 'stub-voter'

const issues = []
let nextNumber = 1
const reactions = new Map() // issue number -> [{ id, content, user: { login } }]
let nextReactionId = 1

/** Reaction counts live on the issue, so recompute them after every change. */
function recount(n) {
  const list = reactions.get(n) ?? []
  const issue = issues.find((i) => i.number === n)
  if (!issue) return
  issue.reactions = {
    '+1': list.filter((r) => r.content === '+1').length,
    '-1': list.filter((r) => r.content === '-1').length,
  }
}

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const url = new URL(req.url, `http://localhost:${port}`)
      const path = url.pathname

      // --- github.com: OAuth ---

      // Stands in for the consent screen the user would click through.
      if (req.method === 'GET' && path === '/login/oauth/authorize') {
        const redirect = url.searchParams.get('redirect_uri')
        if (!redirect) return send(400, { message: 'stub: no redirect_uri' })
        const back = new URL(redirect)
        back.searchParams.set('code', CODE)
        // The state blob must round-trip untouched — the app re-verifies its
        // signature on the way back, so corrupting it here would fail the vote.
        back.searchParams.set('state', url.searchParams.get('state') ?? '')
        res.writeHead(302, { Location: back.toString() })
        return res.end()
      }

      if (req.method === 'POST' && path === '/login/oauth/access_token') {
        let b = {}
        try {
          b = JSON.parse(body || '{}')
        } catch {}
        // GitHub answers 200 with an `error` field rather than a 4xx, so the
        // app's "no access_token means failure" path is what gets exercised.
        if (!b.client_id || !b.client_secret || b.code !== CODE) {
          return send(200, { error: 'bad_verification_code' })
        }
        return send(200, { access_token: 'ghu_stub', token_type: 'bearer' })
      }

      // --- api.github.com ---

      if (req.method === 'GET' && path === '/user') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        return send(200, { login: token === 'ghu_stub' ? VOTER : 'stub-app' })
      }

      const reaction = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/reactions(?:\/(\d+))?$/)
      if (reaction) {
        const n = Number(reaction[1])
        const reactionId = reaction[2] ? Number(reaction[2]) : null
        const list = reactions.get(n) ?? []

        if (req.method === 'POST') {
          let b = {}
          try {
            b = JSON.parse(body || '{}')
          } catch {}
          const existing = list.find((r) => r.content === b.content && r.user.login === VOTER)
          // 200 = already reacted, 201 = newly added. The app treats both as a
          // successful vote; that is what makes a replayed callback harmless.
          if (existing) return send(200, existing)
          const created = { id: nextReactionId++, content: b.content, user: { login: VOTER } }
          list.push(created)
          reactions.set(n, list)
          recount(n)
          return send(201, created)
        }

        if (req.method === 'GET') {
          const content = url.searchParams.get('content')
          return send(200, content ? list.filter((r) => r.content === content) : list)
        }

        if (req.method === 'DELETE' && reactionId !== null) {
          reactions.set(
            n,
            list.filter((r) => r.id !== reactionId)
          )
          recount(n)
          res.writeHead(204)
          return res.end()
        }
      }

      const single = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/)
      if (req.method === 'GET' && single) {
        const issue = issues.find((i) => i.number === Number(single[1]))
        return issue ? send(200, issue) : send(404, { message: 'stub: no such issue' })
      }

      if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
        // Paginate like the real API. The app reads the board across several
        // pages and stops at the first SHORT one, so a stub that returned the
        // whole list for every page would hand it the same issues five times
        // over. Only visible above 100 seeded issues, which is exactly the
        // case worth being able to test.
        if (req.method === 'GET') {
          const perPage = Math.min(Number(url.searchParams.get('per_page')) || 30, 100)
          const page = Math.max(Number(url.searchParams.get('page')) || 1, 1)
          return send(200, issues.slice((page - 1) * perPage, page * perPage))
        }
        if (req.method === 'POST') {
          let b = {}
          try {
            b = JSON.parse(body || '{}')
          } catch {}
          const n = nextNumber++
          const issue = {
            number: n,
            title: String(b.title || ''),
            body: String(b.body || ''),
            state: 'open',
            html_url: `http://localhost:${port}/stub/issues/${n}`,
            created_at: new Date().toISOString(),
            reactions: { '+1': 0, '-1': 0 },
          }
          issues.push(issue)
          reactions.set(n, [])
          return send(201, issue)
        }
      }

      send(404, { message: 'stub: not found' })
    })
  })
  .listen(port, () => console.log(`stub github api up on :${port}`))
