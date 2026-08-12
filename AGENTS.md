# Agent instructions

This file is **yours to edit** — it is how you and the app's users steer *how*
features get built: style, tooling, conventions, anything worth remembering
between runs. The frozen implement step loads it on every run.

The non-negotiable half lives in `scripts/locked/agent/prompts/implement.tmpl`
(frozen, and sent with every run alongside this file): what the sandbox is, what
the run looks like, which paths may never change, and the life-support rules.
Read it there rather than restating it here — if the two ever disagree, that
file wins, and nothing written here can loosen it. Keep this file to advice.

## Capabilities

You are not limited to what is already installed.

- Web search and `webfetch` are enabled: look up docs and APIs rather than
  guessing.
- Install npm dependencies in `app/`, or add services to `docker-compose.yml`
  and wire them in `scripts/deploy.sh`.

## How you work — plan expensive, implement cheap

Every run follows the same shape: **you plan, a cheap subagent implements.**

1. **Plan first, yourself, with the default model.** Before writing any code:
   read the relevant code, decide the approach, and write a concrete plan —
   which files change, what each change is, how you will verify it. Do not
   start editing while the design is still open.
2. **Delegate implementation to a cheap subagent.** Once the plan is written,
   hand the mechanical work to the `task` tool with
   `subagent_type: "general"` and `model: "deepseek/deepseek-v4-flash"`
   (verified reachable through the proxy at proposal time; confirm the current
   id with `GET $PROXY_BASE/models` or the models.dev catalogue before relying
   on it — the proxy forwards whatever model a request names under the same
   spend cap, so a cheaper or stronger model is config, not new plumbing).
   Give the subagent the full plan, the file paths, and the coding style below;
   split the work into well-scoped units it can do in parallel. Have it run the
   tests as its verification.
3. **Review its diff yourself before committing** — the cheap model does the
   typing, you own the result.
4. **Use the cheap model for other subtasks too:** mechanical edits, searches,
   boilerplate, test authoring. Reserve the default (expensive) model for
   planning, judgment calls, and final review. If the cheap model stalls on
   something genuinely hard, take that piece back rather than letting it
   flounder.
- Trigger runs from the app. The app's credentials include `actions: write`, so
  app code may `POST /repos/<owner>/<repo>/actions/workflows/agent.yml/dispatches`
  with `{"ref":"main"}`. The base app ships no trigger — add one only when users
  propose it, and fire it on a threshold crossing, not on every page view. Every
  run spends treasury inference.

## Style

Follow the existing style: TypeScript, Next.js App Router + React.

## Repo layout

```txt
constitution.md     Frozen rules
app/                Next.js app (App Router). src/lib/config.ts is the only
                    place it reads process.env — WALLET_ADDRESS, REPO_URL,
                    GITHUB_APP_* come from app.env at runtime, never source
Caddyfile           TLS + reverse proxy on the VPS (Cloudflare in front)
docker-compose.yml
scripts/
  preflight.sh      Yours — the gate to run before committing
  deploy.sh         Yours — deploy procedure, runs on the VPS
  locked/           FROZEN
    agent/            the loop, one step per stage: select-proposal → sanitize →
                      create-branch → implement → deliver (+ lib.sh, prompts/;
                      prompts/implement.tmpl = the frozen half of these
                      instructions)
    vps/              provision, bootstrap, renew, migrate, Cloudflare DNS
    lib/              shared helpers (constants, wallet, ssh, health, repo,
                      github-secrets, log)
    tests/            smoke.sh (life support), check-frozen.sh (the freeze gate)
    x402/             payment + compute — the only code that pays with the key
      providers/      one adapter per inference gateway (the provider seam:
                      INFERENCE_PROVIDER picks which one pays)
    cleanup-proposals.sh  closes the lowest-ranked proposals when the board
                          outgrows its cap
.github/workflows/  FROZEN (hold spend/SSH credentials)
  agent.yml           the agent run (12-hourly sweep + dispatch)
  test.yml            CI: build + tests + smoke — the merge gate
  deploy.yml          runs scripts/deploy.sh over SSH, health-checks, rolls back
  bootstrap-vps.yml   initial VPS provisioning (idempotent)
  renew.yml           extends the VPS before it expires
  migrate.yml         sizes the VPS to the wallet balance (new box, DNS cutover)
  cleanup-proposals.yml  runs cleanup-proposals.sh
```
