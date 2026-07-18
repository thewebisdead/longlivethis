# Agent instructions

## Context

This is a self-funding living app.

A GitHub Actions workflow runs a Pi agent — a daily scheduled sweep, plus any
run dispatched on demand (see Capabilities): it screens proposals against
`constitution.md`, then implements the first that passes. Spending
credentials exist only in that workflow — never in the app or on the VPS.

Proposals live in **GitHub Issues** — there is no database. The app creates one
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

**Step 0 — Complexity assessment (do this first, before any code):**

1. Read the proposal carefully and classify it into one of three tiers:
   - **cheap**: pure UI tweaks, text/label/color changes, tiny config adjustments
     (≤ ~15 lines changed, no new logic, no new files except tests)
   - **standard**: new React components, moderate logic additions, API wiring,
     small new features with clear scope (default tier)
   - **complex**: multi-file architecture changes, new infra services, security-
     sensitive code, anything requiring research or multi-step design

2. Based on the tier, **switch to the appropriate model** by updating
   `.pi-agent/models.json` with the right model id before doing any work.
   Use the cheapest model that can reliably implement the feature:

   - **cheap tier** → `anthropic/claude-haiku-3-5` (fast, cheap, great for
     straightforward tasks)
   - **standard tier** → `deepseek/deepseek-prover-v2` (cost-efficient;
     strong code reasoning; use this as the default implementation model)
   - **complex tier** → keep `anthropic/claude-sonnet-4.6` as the main model;
     spawn a DeepSeek V4 Pro subagent (`deepseek/deepseek-prover-v2`) for the
     actual code-writing sub-tasks (research, scaffolding, test generation);
     synthesize results yourself.

   To switch models, overwrite `.pi-agent/models.json` to include all needed
   model entries under the `x402gate` provider (same `baseUrl`, same `apiKey
   "x402"`, same cost zeros — the proxy handles billing). Then use `/model`
   (in interactive mode) or `--model <id>` flag if spawning sub-processes.

   **Always register both the primary model and DeepSeek** so subagent calls
   resolve. Run this snippet at the very start of every Phase 2 run:
   ```bash
   PROXY_BASE="$(cat /tmp/pi-proxy-port.json 2>/dev/null | jq -r .baseUrl || echo $PROXY_BASE)"
   # Add DeepSeek V4 Pro as a second registered model for subagent use
   jq --arg base "$PROXY_BASE" '
     .providers.x402gate.models += [{
       id: "deepseek/deepseek-prover-v2",
       name: "deepseek/deepseek-prover-v2",
       reasoning: false,
       input: ["text"],
       contextWindow: 128000,
       maxTokens: 16384,
       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
     }]' .pi-agent/models.json > /tmp/m.json && mv /tmp/m.json .pi-agent/models.json
   ```
   Then spawn implementation subagents with:
   ```bash
   pi --model deepseek/deepseek-prover-v2 --provider x402gate --api-key x402 \
      --no-session --mode text "Implement: <task description>"
   ```
   (Note: model switching only takes effect on the **next** Pi session start;
   within a running session you can use `/model` to switch interactively.)

3. For **complex** proposals, expand the proposal into a concrete task list
   before coding. Write 3–8 discrete, testable sub-tasks. Tackle each in order;
   use DeepSeek V4 Pro subagent bash sub-processes for the actual code-writing
   tasks (it is significantly cheaper than Sonnet, saving treasury funds for
   more proposals). Example:
   ```bash
   pi --model deepseek/deepseek-prover-v2 --provider x402gate --api-key x402 \
      --no-session --mode text "Research: what npm packages exist for X?"
   ```
   Synthesize the results yourself rather than trusting sub-agent output blindly.

**Step 1–4 (unchanged after the assessment above):**

1. Implement the allowed feature. Keep it minimal — one feature, one branch.
2. Adjust or add tests. Do not break existing tests.
3. Run `./scripts/preflight.sh` (receive-only check + build + tests + smoke).
   Fix until it passes.
4. Commit your work. Do not push or open a PR — you hold no credentials to, and
   the deliver step does it automatically after you exit.

After you exit, the deliver step pushes the branch and opens a PR with
`Closes #<issue>` in the body, then enables auto-merge (squash). Once the
`test` check passes, GitHub merges the PR, the push to `main` triggers the
deploy, and the proposal issue closes automatically. A PR that closes without
merging frees its issue again. If you cannot implement the feature, exit
without committing — the run simply produces no PR and the proposal stays open.

## Capabilities

You are not limited to what is already installed. Pi is extendable — if a
feature needs something you don't have, get it. Check the Pi docs at
<https://pi.dev/docs/latest> for how to extend Pi (extensions, commands, config)
before assuming a capability is missing:

- Search the web for docs, APIs, or approaches you're unsure about.
- Install packages (npm dependencies in `app/`, or tools in the workflow
  environment) when a feature needs them.
- Add services to `docker-compose.yml` and wire them in `scripts/deploy.sh`
  when a feature needs infrastructure.
- Run on a different model when a task warrants it. The implement step runs one
  base-model Pi run, but the payment proxy forwards whatever model a request
  names (within the same spend cap). Pi supports switching with `/model` (see
  <https://pi.dev/docs/latest>). A proposal may add a model-switch tool or Pi
  extension and note here when to use it — e.g. spawn a subagent on a stronger
  model for hard changes — registering its own models (the frozen step only
  declares the base one).
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
  - `smoke.sh` — the app's life-support contract (the homepage must load and
    proposal intake must work). Features may change how these look, never
    remove them; smoke.sh must pass.
  - `agent/` — the loop's brainstem, split into one frozen step per stage
    (`select-proposal.sh` → `sanitize.sh` → `create-branch.sh` →
    `implement.sh` → `deliver.sh`, with `lib.sh` and `prompts/`). Together they
    guarantee proposals are fetched, gated, implemented, and delivered every
    run. `implement.sh` is a single frozen Pi run that reads **this AGENTS.md**
    for its rules — steer how features get built by editing AGENTS.md (and the
    prompt templates are for reference only; they are frozen).
  - `x402-proxy.mjs`, `x402gate.mjs`, `renew-vps.mjs`, `x402compute.mjs` —
    they run inside credential-bearing workflows and are the only code that
    ever touches `WALLET_PRIVATE_KEY`. Your environment never has the key;
    inference is paid through the local proxy (`PROXY_BASE`).
  - `check-receive-only.sh` and `check-frozen.sh` — the gates that keep spend
    secrets out of `app/` and frozen files unchanged; CI runs the base ref's
    copy, so a gate you could edit in the PR it gates would be no gate.
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
scripts/
  locked/               FROZEN — never modify, delete, or add anything here
    agent/                brainstem, one step per stage: select-proposal →
                          sanitize → create-branch → implement → deliver
                          (+ lib.sh, prompts/); implement is one Pi run reading
                          this AGENTS.md
    smoke.sh              life-support check (boots prod image against a stub GitHub API)
    x402-proxy.mjs        payment proxy (only holder of the wallet key)
    x402gate.mjs          x402 payment lib
    renew-vps.mjs         VPS renewal (runs in renew.yml with the wallet key)
    x402compute.mjs       x402 compute lib
    check-receive-only.sh spend-secret grep (CI + preflight gate)
    check-frozen.sh       frozen-file check (CI runs the base ref's copy)
  preflight.sh          Receive-only + frozen check + build + tests + smoke (agent gate)
  deploy.sh             Deploy procedure on the VPS (AGENT-OWNED — edit this)
.github/workflows/      FROZEN (hold spend/SSH credentials)
  agent.yml         Agent run (daily sweep + on-demand dispatch): starts the
                    payment proxy (wallet key stays there), then runs the
                    frozen scripts/locked/agent/ steps with no spend keys
  renew.yml         Extend the VPS before it expires (spend secret)
  test.yml          CI: build + tests + smoke (no spend secrets)
  deploy.yml        Frozen wrapper → runs scripts/deploy.sh over SSH (VPS_* only);
                    health-checks the live site after, auto-rolls-back if dead
```

## Treasury

`WALLET_ADDRESS` is public (tips + treasury display). Private key and inference
credentials live in GitHub Secrets for `agent.yml` only — not on the VPS.
