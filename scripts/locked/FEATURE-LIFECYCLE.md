# Feature lifecycle

FROZEN at init — describes how a new feature travels from user proposal to
production. This file documents the process; the scripts and workflows named
below are the process. If they ever disagree, the code wins.

```txt
user submits proposal (app)
        │  fine-grained Issues-only token
        ▼
GitHub Issue  ←— votes: 👍 +1 / 👎 −1 reactions
        │
        ▼
agent.yml run (daily sweep 04:23 UTC, or workflow_dispatch from app code)
        │  x402 proxy started first — sole holder of WALLET_PRIVATE_KEY
        ▼
scripts/locked/agent/*.sh   (one frozen step per stage)
        │ 1. select-proposal — fetch + rank open proposals (net votes),
        │    constitution gate → ALLOW / DENY (denied issues closed)
        │ 2. sanitize — clean the untrusted proposal text
        │ 3. create-branch — branch feat/<slug> (+ prior-attempt context)
        │ 4. implement — one frozen Pi run (reads AGENTS.md for its rules)
        │ 5. deliver — push branch, open PR "Closes #N", enable auto-merge
        ▼
test.yml CI gate (frozen-file check, receive-only check, build, tests, smoke)
        │  pass → GitHub squash-merges to main
        ▼
deploy.yml → scripts/deploy.sh on the VPS → external health check
        │  unhealthy → auto-rollback to `last-good`
        ▼
live; merge closed the proposal issue
```

## 1. Proposal intake

A user submits a proposal through the app. The app creates one GitHub Issue
per proposal using a fine-grained, Issues-only GitHub App token — there is no
database. Voting is the 👍/👎 reactions on the issue: net score = 👍 − 👎,
other emojis ignored. Issues not authored by the app's bot identity, and all
issue comments, are ignored by the agent.

## 2. Agent run starts (`agent.yml`)

Runs on a daily scheduled sweep, or on demand when app code dispatches the
workflow (the app's credentials include `actions: write`; the base app ships
no trigger). A concurrency group ensures only one agent run at a time.

The workflow first starts `scripts/locked/x402-proxy.mjs` — the **only**
process that ever holds `WALLET_PRIVATE_KEY`. It pays x402 inference charges
and exposes a local OpenAI-style endpoint (`PROXY_BASE`). Everything after
that step, including all agent code, spends only through the proxy and never
sees the key.

## 3. Selection and constitution gate (`agent/select-proposal.sh`, frozen)

The loop is a sequence of frozen steps under `scripts/locked/agent/`, each a
separate workflow step that passes state to the next through `$AGENT_STATE`.
Only the deliver step gets `GH_TOKEN`; the implement step gets none.

1. Fetch open proposal issues authored by the app identity, ranked by net
   votes. Skip net-negative proposals and issues already claimed by an open
   **agent-authored** PR whose body starts with `Closes #N` (PRs by anyone
   else cannot claim a proposal).
2. For each candidate in order, run a constitution-only inference check
   against `constitution.md` → `ALLOW` or `DENY: <reason>` (prompts live in
   `agent/prompts/`).
3. First `ALLOW` wins. Denied proposals are closed as "not planned" with the
   reason as a comment, so they never re-enter the queue. If none pass, the
   remaining steps are skipped and no PR opens.

## 4. Sanitize, branch, implement

`sanitize.sh` produces the single cleaned copy of the untrusted proposal text
that every later step reads: control characters stripped, issue references
neutralized (`#12` → `# 12`), length capped.

`create-branch.sh` creates a feature branch `feat/<slug>` from `origin/main`
(suffixed if a prior failed attempt left a branch — that history is offered
to the agent as context).

`implement.sh` is a single frozen Pi run with `GH_TOKEN` scrubbed and inference
routed through the proxy. The prompt carries the proposal plus a few
non-negotiable reminders; Pi reads the repo's `AGENTS.md` automatically for
everything else — style, extra rules, approach. There is no agent-owned
implementation layer, so nothing here can be broken into stopping the loop, and
users steer how features are built by editing `AGENTS.md` (which stays mutable —
enforcement lives in the frozen substrate below, not in the prompt).

The implementer must run `./scripts/preflight.sh` (receive-only check +
frozen-file check + build + tests + smoke) and commit only when it passes.
It does not push or open the PR — it holds no credentials to.

## 5. Delivery

`deliver.sh` pushes the branch (commits only — the agent must commit its
own work) and opens a PR whose body **starts** with `Closes #N`. Because the
quoted proposal text was already sanitized, it cannot smuggle a closing
keyword — only that `Closes #N` line closes the issue. Auto-merge (squash) is
enabled.

## 6. CI gate (`test.yml`) — the last gate before main

There is no human review; branch protection requires the `test` check:

- **Frozen files unchanged** — the *base ref's* copy of `check-frozen.sh`
  verifies `constitution.md`, everything in `scripts/locked/` (including this
  file), and `.github/workflows/` are untouched. Running the base ref's copy
  means a PR that tampers with the check is judged by the untampered version.
- **Receive-only** — `check-receive-only.sh` greps `app/` for spend secrets.
- Build, tests, and `smoke.sh` — the production image must serve the
  life-support endpoints (homepage, proposal intake, treasury, constitution)
  against a stub GitHub API.

When the check passes, GitHub squash-merges the PR into `main`.

## 7. Deploy and health check (`deploy.yml`)

The push to `main` triggers the frozen deploy wrapper: SSH to the VPS (pinned
host key), `git reset --hard origin/main`, run the agent-owned
`scripts/deploy.sh`. An external health check then hits the live site; on
failure the VPS is rolled back to the `last-good` tag and that commit's own
`deploy.sh` re-runs. Only after a healthy check is `last-good` moved forward.

Merging the PR closes the proposal issue via the `Closes #N` line. A PR that
closes **without** merging frees its issue to be attempted again on a later
run.
