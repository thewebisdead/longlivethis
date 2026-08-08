# Agent instructions

## Context

This is a self-funding living app.

A GitHub Actions workflow runs an opencode agent — a daily scheduled sweep, plus any
run dispatched on demand (see Capabilities): it screens proposals against
`constitution.md`, then implements the first that passes. Spending
credentials exist only in that workflow — never in the app or on the VPS.

Proposals live in **GitHub Issues**. The app creates one
issue per user-submitted proposal using a fine-grained Issues-only token; votes
are the 👍/👎 reactions on the issue (👍 +1, 👎 −1, other emojis ignored).
Issues not authored by that token identity, and all issue comments, are ignored.

## Your job (each run — two phases)

### Phase 1 — Constitution gate (handled by the loop before you run)

The frozen `select-proposal` step does this automatically — you don't:

1. Fetch open proposal issues from the GitHub API (`creator=<app identity>`,
   ranked by net 👍 minus 👎 reactions), skipping issues already claimed by an
   open agent-authored PR and issues with a net-negative score.
2. For each candidate, a constitution-only check against `constitution.md`
   replies `ALLOW` or `DENY: <reason>`.
3. The first `ALLOW` is selected and handed to you. Denied proposals are closed
   as "not planned" with the `DENY` reason as a comment, so they never
   re-enter the queue.
4. If none pass, the run ends before Phase 2 — no PR.

### Phase 2 — Implement (this is the run you are in)

The feature branch is already created and checked out for you.

1. Implement the allowed feature. Keep it minimal — one feature, one branch.
2. Finish it — **no user intervention required.** What you ship must work on the
   live site the moment the PR merges, with nobody doing anything on its behalf.
   That means the setup is part of the feature, not a follow-up: config wired in
   `scripts/deploy.sh` / `docker-compose.yml`, dependencies installed, migrations
   or seed data applied on boot, defaults chosen so the code path is live rather
   than dormant. Never leave a TODO, a stub, a feature flag someone has to flip,
   or a README line telling a human to sign up somewhere, paste a key, click
   through a console, or run a command on the server. If the only way to finish
   the feature is a human step, you cannot finish it — exit without committing
   (see below) rather than shipping a half-feature that waits on someone.
3. Adjust or add tests. Do not break existing tests.
4. Run `./scripts/preflight.sh` (frozen check + build + tests + smoke).
   Fix until it passes.
5. Commit your work. Do not push or open a PR — you hold no credentials to, and
   the deliver step does it automatically after you exit.

After you exit, the deliver step pushes the branch and opens a PR with
`Closes #<issue>` in the body, then enables auto-merge (squash). Once the
`test` check passes, GitHub merges the PR, the push to `main` triggers the
deploy, and the proposal issue closes automatically. A PR that closes without
merging frees its issue again. If you cannot implement the feature, exit
without committing — the run simply produces no PR and the proposal stays open.

## Capabilities

You are not limited to what is already installed. opencode is extendable — if a
feature needs something you don't have, get it. Check the opencode docs at
<https://opencode.ai/docs/> before assuming a capability is missing:

- Search the web for docs, APIs, or approaches you're unsure about. You have
  both `webfetch` (retrieve a known URL) and web search enabled.
- Install packages (npm dependencies in `app/`, or tools in the workflow
  environment) when a feature needs them.
- Add services to `docker-compose.yml` and wire them in `scripts/deploy.sh`
  when a feature needs infrastructure.
- Delegate to a subagent on a different model when a task warrants it. Use the
  `task` tool; subagents are a native opencode primitive, so this needs no
  extension. The frozen step declares only the base model, but the payment proxy
  forwards whatever model a request names, within the same spend cap — so a
  cheaper model for mechanical work or a stronger one for a hard change is a
  config change, not new plumbing. The full models.dev catalogue is loaded at
  startup, so you can look up what exists, its context window and its real cost
  rather than guessing.

  **Verify a model before you rely on it.** Naming a model in config proves
  nothing: an unreachable or misnamed id fails at the moment of use, often
  silently. Before delegating real work to a model you have not used here
  before, send it a trivial prompt through the proxy and confirm you get a
  response back. A past proposal registered `deepseek/deepseek-prover-v2` for
  "cheaper implementation" — a Lean theorem prover, never actually invoked — and
  the run cost exactly as much as before. Registering is not using; if you did
  not see a reply, it does not work.
- Trigger agent runs from the app. The workflow only runs a daily sweep by
  itself; the app's `GITHUB_APP_*` credentials include `actions: write`, so
  app code may dispatch an immediate run
  (`POST /repos/<owner>/<repo>/actions/workflows/agent.yml/dispatches`, body
  `{"ref":"main"}`). The base app ships with **no** trigger — add one only
  when users propose it (e.g. "implement a proposal as soon as it reaches a
  two-thirds majority"). Every run spends treasury inference, so make
  triggers deliberate: fire on a threshold crossing, not on every page view.

The frozen-file rules and receive-only constraint still apply — extend your
capabilities, never your access to spend credentials.

## Communication

- Do not narrate progress, write long summaries, or explain what you did.
- Prefer tool calls and code edits over prose.
- Only write text when blocked or when a one-line status is required.

## Rules

- **Never modify `constitution.md`.** Frozen at init — the single copy at the
  repo root; the homepage links to it on GitHub.
  The freeze is enforced by branch protection + the frozen-file check in the
  `test` CI gate, which every PR must pass to merge.
- **Never modify anything in `scripts/locked/`.** The whole directory is
  frozen — no edits, deletions, or additions. It holds:
  - `smoke.sh` — the app's life-support contract (proposal intake must work:
    `POST /api/proposals` returns 201). Features may change how this looks,
    never remove it; smoke.sh must pass.
  - `agent/` — the loop's brainstem, split into one frozen step per stage
    (`select-proposal.sh` → `sanitize.sh` → `create-branch.sh` →
    `implement.sh` → `deliver.sh`, with `lib.sh` and `prompts/`). Together they
    guarantee proposals are fetched, gated, implemented, and delivered every
    run. `implement.sh` is a single frozen opencode run that reads **this AGENTS.md**
    for its rules — steer how features get built by editing AGENTS.md (and the
    prompt templates are for reference only; they are frozen).
  - `x402/x402-proxy.mjs`, `x402/x402inference.mjs`, `x402/x402compute.mjs`, and
    `vps/renew-vps.mjs` — they run inside credential-bearing workflows and are
    the only code that ever touches `WALLET_PRIVATE_KEY`. Your environment never
    has the key; inference is paid through the local proxy (`PROXY_BASE`).
  - `check-frozen.sh` — the gate that keeps frozen files unchanged; CI runs
    the base ref's copy, so a gate you could edit in the PR it gates would be
    no gate. (Spend secrets are kept out of `app/` by rule, not by a grep
    gate — see "Receive-only app" below.)
- **Never modify `.github/workflows/`.** Frozen — they hold spend/SSH credentials.
  To change how the app is built or deployed (services, build steps),
  edit `scripts/deploy.sh`, which runs on the VPS where no spend keys exist.
- **Receive-only app.** Never add `WALLET_PRIVATE_KEY` or spend paths to `app/`.
  The app may only display `WALLET_ADDRESS` and receive incoming funds. The app's
  `GITHUB_APP_*` credentials mint short-lived installation tokens for a
  GitHub App installed on this repo only. Never widen their use beyond
  creating/reading proposal issues and dispatching `agent.yml` runs.
- **No database.** Proposals are GitHub Issues. If a feature genuinely needs
  persistent storage, add a service to `docker-compose.yml` and wire it in
  `scripts/deploy.sh` (both agent-owned) — keep the proposal store on GitHub.
- Never commit, print or echo `secrets.env`, `*.env` with private keys, or `*.key` files.
- Never push directly to `main`.
- Follow existing code style (TypeScript, Next.js App Router + React).
- Keep changes in `app/` unless the feature explicitly requires infra.
- PR must pass the `test` CI check before it can be merged (branch protection);
  it then auto-merges — there is no human review, so preflight is the last gate.

## Repo layout

```
constitution.md     Frozen rules (immutable)
app/                Next.js app (App Router); proposals via GitHub Issues (receive-only wallet)
  src/lib/config.ts     the only place the app reads process.env — deployment
                        config (WALLET_ADDRESS, REPO_URL, GITHUB_APP_*) comes
                        from app.env at runtime, never hard-coded in source
scripts/
  locked/               FROZEN — never modify, delete, or add anything here
    agent/                brainstem, one step per stage: select-proposal →
                          sanitize → create-branch → implement → deliver
                          (+ lib.sh, prompts/); implement is one opencode run reading
                          this AGENTS.md
    vps/                  server lifecycle:
      bootstrap.mjs         initial-deploy entry point (runs in bootstrap-vps.yml)
      provision-vps.mjs     provision + bootstrap + health-check a box (init + migrate share this)
      runway.mjs            extend a box's prepaid window (shared: renew, bootstrap, migrate)
      renew-vps.mjs         scheduled VPS renewal (runs in renew.yml with the wallet key)
      migrate-vps.mjs       balance-driven server migration (runs in migrate.yml)
      bootstrap-vps.sh      brings a bare box up to deployable (init + migrate)
      dns.mjs               Cloudflare A-record upsert (DNS cutover in migrate)
    lib/                  shared frozen helpers (constants, wallet, ssh, health,
                          repo URL, GitHub secrets, logging)
    tests/                CI/preflight gates:
      smoke.sh              life-support check (boots prod image against a stub GitHub API)
      check-frozen.sh       frozen-file check (CI runs the base ref's copy)
    x402/                 payment + compute (the only code that pays with the
                          wallet key): proxy, gate client, compute client, and
                          install-x402-deps.sh (the shared pin source)
  preflight.sh          Frozen check + build + tests + smoke (agent gate)
  deploy.sh             Deploy procedure on the VPS (AGENT-OWNED — edit this)
.github/workflows/      FROZEN (hold spend/SSH credentials)
  bootstrap-vps.yml  Initial VPS provisioning (idempotent; dispatched by init, safe to re-run)
  agent.yml          Agent run (daily sweep + on-demand dispatch): starts the
                    payment proxy (wallet key stays there), then runs the
                    frozen scripts/locked/agent/ steps with no spend keys
  renew.yml         Extend the VPS before it expires (spend secret)
  migrate.yml       Size the VPS to the wallet balance: provision a new box,
                    cut DNS + deploy secrets over, retire the old (spend + PAT +
                    Cloudflare). Inert unless CF_*/ROTATOR_APP_*/APP_ENV are set.
  test.yml          CI: build + tests + smoke (no spend secrets)
  deploy.yml        Frozen wrapper → runs scripts/deploy.sh over SSH (VPS_* only);
                    health-checks the live site after, auto-rolls-back if dead
```

## Treasury

`WALLET_ADDRESS` is public. Private key and inference
credentials live in GitHub Secrets for `agent.yml` only — not on the VPS.
