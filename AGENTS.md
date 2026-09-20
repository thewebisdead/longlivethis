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

- `webfetch` is enabled: read the docs for an API rather than guessing at it.
  There is no web *search* tool — you fetch a URL you already have.
- Install npm dependencies in `app/`, or add services to `docker-compose.yml`
  and wire them in `scripts/deploy.sh`.
- **Keep data between runs.** `/var/lib/longlive/state` on the host is the one
  directory that outlives the box. Everything else — containers, volumes,
  anything written elsewhere — is rebuilt from this repo plus `app.env` when the
  deployment resizes itself to its wallet, and is gone. Mount it where you need
  it (`docker-compose.yml` is yours) and it comes across to the new box. This is
  what makes a database, uploaded files, or anything the app generates about
  itself possible; without it, features that remember things quietly lose them
  at the next resize.

  Three rules come with it. **Write atomically** (temp file + `rename`): the
  copy is taken while the app is still serving, so a file caught mid-write is
  copied mid-write, and the last writes before cutover are lost — the same
  discipline that survives a reboot. **Stay under the cap** (the
  `STATE_CARRY_MAX_MB` repo variable, 256MB by default): a directory over it is
  left behind rather than delaying a migration, so prune what you write and ask
  for the variable to be raised in a proposal if the app genuinely needs more.
  **Tolerate an empty one**: if the carried state ever makes the app fail its
  health check it is parked aside and the app restarts without it, so treat
  "the directory is empty" as a normal first boot, never as an error.
- **Give yourself new tools.** Pi loads every extension in `.pi/extensions/`
  (`*.ts`, or `*/index.ts`) at startup, and that directory is yours — an
  extension is a normal commit on a normal PR. A tool is a `pi.registerTool()`
  call with a name, a description, a typebox parameter schema and an `execute`;
  `scripts/locked/agent/extensions/webfetch.ts` is a worked example, frozen so
  it cannot be lost. Imports of `@earendil-works/pi-coding-agent` and `typebox`
  are provided; anything else needs a `package.json` next to the extension and
  an install that nobody pinned, so prefer none. This is the honest way to add a
  search tool, a subagent, a linter gate — anything that ought to outlive one
  run. Keep them small and dependency-free, and **make sure yours loads**: an
  extension that throws on load stops Pi before it makes a single request. The
  frozen step survives that by retrying the run with every `.pi/extensions/`
  entry disabled (the frozen `webfetch` stays), so a bad one costs the agent
  its own tools, not the loop — but it costs them on every run until someone
  fixes it, and CI does not run Pi, so nothing catches it for you. Import it in
  a test, or start from the worked example and change one thing at a time.
- Choose a model. The ids in `INFERENCE_MODEL` are declared to Pi as
  `inference/<id>` and served by the proxy's `GET /v1/models`; Pi loads no
  remote catalogue here, so those are the ones you can *select*. The proxy
  itself is looser: it forwards whatever model a request names and pays for it
  under the same spend cap, so an extension that POSTs to `$PROXY_BASE`
  directly can reach a model outside the list — and can set request fields Pi
  never sends. That is the seam for a subagent or a gateway-side capability;
  there is no built-in subagent tool. Verify before relying on it: one trivial
  request through the proxy, and read the answer.
- **Model policy (cost saving).** The app never runs inference itself, but it
  decides which model tier each run *should* use and records it on the agent
  activity log. `app/src/lib/modelPolicy.ts` maps the spend-guard mode to a
  tier: a downshifted / routine run routes to the cheapest capable model, a
  normal run keeps the full-power model, and a skip spends nothing. Configure
  the ids in `app.env` on the VPS (`CHEAP_MODEL`, `COMPLEX_MODEL`; defaults
  keep the path live when unset) and align `CHEAP_MODEL` with a later entry of
  the frozen `INFERENCE_MODEL` repo list so the proxy actually routes to it.
  The dispatcher (`agentTrigger.ts`) records the recommended tier + model on
  every evaluation; `/agent` and `/api/agent/model-policy` surface it. The
  frozen loop's own split (cheap `GATE_MODEL` for screening, primary
  `INFERENCE_MODEL` for implementation) is the same diet enforced on the
  workflow side; keep them consistent.
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
.pi/extensions/     Yours — extensions Pi loads every run (see Capabilities)
app/                Next.js app (App Router). src/lib/config.ts is the only
                    place it reads process.env — WALLET_ADDRESS, REPO_URL,
                    GITHUB_APP_* come from app.env at runtime, never source
Caddyfile           TLS + reverse proxy on the VPS (Cloudflare in front)
docker-compose.yml  Yours — also where you mount the host's durable state dir,
                    /var/lib/longlive/state (see Capabilities); it is not a path
                    in this repo and nothing else on the box outlives a migration
scripts/
  preflight.sh      Yours — the gate to run before committing
  deploy.sh         Yours — deploy procedure, runs on the VPS
  locked/           FROZEN
    agent/            the loop, one step per stage: select-proposal → sanitize →
                      create-branch → implement → deliver (+ lib.sh, prompts/;
                      prompts/implement.tmpl = the frozen half of these
                      instructions; extensions/webfetch.ts = the default tool)
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
