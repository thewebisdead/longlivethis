#!/usr/bin/env bash
# FROZEN at init — step 4: run the implementation.
#
# A single frozen opencode run. There is no agent-owned implementation layer, so
# nothing here can be broken into bricking the loop.
#
# The agent's instructions come from two places. prompts/implement.tmpl is
# FROZEN and carries everything non-negotiable: the proposal, the sandbox it is
# running in, the run contract, the frozen-path list, and the life-support
# rules. The repo's AGENTS.md, which opencode reads automatically, carries only
# user-tunable advice — style, capabilities, layout. The template states that it
# outranks AGENTS.md, so an emptied, corrupted or hostile AGENTS.md costs the
# run advice, never the rules; nothing here depends on that file existing.
#
# Runs with NO credentials: GH_TOKEN is never set on this step, and no wallet
# key exists in this environment — inference is paid only through the proxy.
# Enforcement lives in the frozen substrate (CI gates, credential scrubbing,
# the freeze), not in this prompt, so a mutable AGENTS.md weakens no guarantee.
#
# OS-level isolation: the payment proxy (started by agent.yml) runs as the
# runner user with WALLET_PRIVATE_KEY in its process environment and stays alive
# for the whole job. Step-level env separation is only a shell-variable
# boundary — a same-uid process can read another's /proc/<pid>/environ, and the
# runner has passwordless sudo. So the untrusted agent run is dropped to a
# distinct, sudo-less user (agentuser) that shares no uid with the proxy and
# holds no capabilities: it cannot read the proxy's environ/mem, so the wallet
# key is unreachable no matter what a proposal instructs the agent to do.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

: "${PROXY_BASE:?PROXY_BASE is required (x402 payment proxy)}"
# The one model knob: INFERENCE_MODEL is a comma-separated priority list.
# opencode runs the first; the proxy retries down the rest on provider errors.
# It comes from the INFERENCE_MODEL repo variable — change it there (no code
# change) when a model is retired.
MODEL="$(require_model)"

# Wall-clock bound on the run. opencode retries retryable upstream errors
# (500/429/503, connection refused) with escalating backoff and emits NOTHING to
# stdout or stderr while doing so — an unbounded run would hang to the job
# timeout with no diagnostic. Overridable for slow features; the cap is on the
# agent's own runtime, not on the proposal.
RUN_TIMEOUT="${IMPLEMENT_TIMEOUT:-3600}"

# How many times a run that DIED BY SIGNAL is resumed (see oc_stream). One by
# default: enough to survive a self-inflicted kill, not enough to burn the
# budget re-running the same fatal command. 0 disables resuming entirely.
RESUME_TRIES="${IMPLEMENT_RESUMES:-1}"

PROPOSAL_TEXT="$(state_get proposal_sanitized)"
BRANCH="$(state_get branch)"
PRIOR_SECTION="$(state_get prior_section)"
[ -n "$BRANCH" ] || { echo "implement: no branch in state — nothing to do" >&2; exit 1; }

AGENT_PROMPT="$(render_template "$PROMPTS_DIR/implement.tmpl" \
  "PROPOSAL_TEXT=$PROPOSAL_TEXT" "BRANCH=$BRANCH" "PRIOR_SECTION=$PRIOR_SECTION")"

# Register the proxy as an OpenAI-compatible provider (cost 0 — the proxy has
# already paid the x402 charge). @ai-sdk/openai-compatible is compiled into the
# opencode binary, so naming it here pulls nothing from a registry at run time.
# PROXY_BASE already ends in /v1 (inference-proxy.mjs publishes it that way and
# agent.yml reads it straight from the port file) — do not append it again.
# The context/output limits are stated explicitly because models.dev has no
# entry for a private "inference" provider — the catalogue opencode downloads at
# startup describes public providers, never this one, so without these
# autocompact would have nothing to work from for the base model.
#
# The provider is named "inference", not after whichever gateway is paying:
# which gateway that is comes from the INFERENCE_PROVIDER repo variable and can
# change without the agent's model ids ("inference/<model>") changing with it.
#
# EVERY configured model is declared, not just the primary: the whole
# INFERENCE_MODEL list is what the proxy is willing to route and pay for (it
# retries down the list itself), so declaring all of them lets the agent name a
# sibling model — e.g. hand a cheap subtask to a smaller one via the task tool —
# instead of being pinned to the one id it was launched with. The proxy's
# GET /v1/models serves the same list, so config and endpoint agree.
#
# permission: "allow" — normalized by opencode to {"*": "allow"}, i.e. every
# tool, every pattern, no prompts. This is deliberate. The run is
# NON-INTERACTIVE: there is no human at the other end of a permission prompt,
# so opencode's default ("ask" for anything unmatched) resolves to
# auto-rejecting mid-run — a sweep once died because the agent ran a bash
# command touching /tmp and lost the tool call, then gave up with no commits.
# Nothing is being conceded by allowing everything: containment here is the uid
# sandbox (agentuser, sudo-less, cannot read the proxy's environ) and the fact
# that this step holds no credentials, not opencode's own permission list —
# which the agent could not be blocked by anyway once it has bash.
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$REPO_ROOT/.opencode-agent}"
mkdir -p "$OPENCODE_CONFIG_DIR"
require_models | jq -R -s --arg base "$PROXY_BASE" '
(split("\n") | map(select(length > 0))) as $ms | {
  "$schema": "https://opencode.ai/config.json",
  permission: "allow",
  provider: { inference: {
    npm: "@ai-sdk/openai-compatible", name: "inference",
    options: { baseURL: $base, apiKey: "x402" },
    models: ($ms | map({ key: ., value: {
                name: ., limit: { context: 128000, output: 16384 },
                cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } })
             | from_entries)
  } }
}' > "$OPENCODE_CONFIG_DIR/opencode.json"

# --- Run opencode as an unprivileged sandbox user (see header) --------------
# Assumes GitHub-hosted ubuntu-latest: the runner has passwordless sudo and the
# proxy runs as the runner user. On a self-hosted runner without passwordless
# sudo the isolation cannot be established; rather than fail the loop we run the
# agent as the current user and warn loudly (no silent security downgrade).
OC_BIN="$(command -v opencode)"
OC_USER=agentuser

# Runtime flags, passed into the sandbox (see the env -i allowlist below).
#   OPENCODE_PURE                — no external plugins. Without it opencode
#       npm-installs ~61MB into its config dir on first run; the sandbox is
#       sudo-less with no registry credentials, so that install is both a
#       needless dependency and a needless network reach. Built-in tools
#       (bash/edit/read/webfetch/task/skill/…) and AGENTS.md are unaffected.
#   (models.dev catalogue: deliberately LEFT ENABLED. opencode downloads the
#       full model catalogue at startup (~3MB) so the agent knows what models
#       currently exist, their context limits and their real costs — needed for
#       it to reason about delegating a subtask to a cheaper or stronger model
#       rather than guessing an id. Naming a model is not the same as reaching
#       it: every request still goes through the proxy, which pays x402 under
#       the same spend cap, so the catalogue widens what the agent can CHOOSE,
#       never what it can spend. Set OPENCODE_DISABLE_MODELS_FETCH=1 to drop it
#       — that also drops ~3MB of startup network and cuts run time.)
#   OPENCODE_DISABLE_AUTOUPDATE   — the version is pinned in agent.yml. An
#       agent that could self-update could pick its own binary.
#   OPENCODE_DISABLE_LSP_DOWNLOAD — no language servers fetched mid-run.
#   OPENCODE_ENABLE_EXA           — web search. webfetch retrieves a known URL;
#       this adds search, so the agent can find docs/APIs it does not know.
#       Deliberate: it also widens what a hostile proposal can pull in. The step
#       holds no credentials and the repo is public, so the exposure is wasted
#       spend and bad PRs, which the PR gate catches — not key loss.
OC_FLAGS=(
  OPENCODE_PURE=1
  OPENCODE_DISABLE_AUTOUPDATE=1
  OPENCODE_DISABLE_LSP_DOWNLOAD=1
  OPENCODE_ENABLE_EXA=1
)

# Run opencode ("$@" is the launcher: sudo/env wrapper + "$OC_BIN") and stream
# its full activity to the CI log. --format json emits every event (assistant
# text, tool calls + results) as one JSON object per line — printed raw. The
# stream is also kept on disk: it is where the session id and any error event
# are read from afterwards (see oc_stream). One file per attempt, so a resume
# does not overwrite the record of what killed the previous one.
#
# --model belongs to the `run` subcommand, so it is appended here rather than
# by the callers. --kill-after: the timeout signals the sudo wrapper, which does
# not reliably forward INT to the sandboxed child; SIGKILL after a grace period
# guarantees the step ends.
#
# `timeout` is GNU coreutils: present on ubuntu-latest, absent on macOS and some
# self-hosted runners. Missing it costs a guard, not the loop — warn and run
# unbounded rather than failing the step outright (same principle as the sudo
# fallback below).
RAW="${RUNNER_TEMP:-/tmp}/opencode-events.jsonl"
if command -v timeout >/dev/null 2>&1; then
  HAS_TIMEOUT=1
else
  echo "::warning::coreutils 'timeout' not found — running opencode WITHOUT a wall-clock bound; a silently-retrying upstream error will hang until the job timeout."
  HAS_TIMEOUT=0
fi

# The opencode session id, carried on every event in the stream. Needed to
# resume a killed run; the first event is enough.
session_of() { grep -o '"sessionID":"[^"]*"' "$1" 2>/dev/null | head -1 | cut -d'"' -f4; }

# One opencode invocation: oc_launch BUDGET RAWFILE PROMPT SESSION LAUNCHER...
# An empty SESSION starts a new session; otherwise the run resumes that one.
oc_launch() {
  local budget="$1" raw="$2" prompt="$3" sid="$4"; shift 4
  local rc=0
  local -a t=() s=()
  [ "$HAS_TIMEOUT" -eq 1 ] && t=(timeout --signal=INT --kill-after=60 "$budget")
  [ -n "$sid" ] && s=(--session "$sid")
  # ${arr[@]+"${arr[@]}"}: expands to nothing when the array is empty without
  # tripping `set -u` on bash 3.2 (macOS); runners ship bash 5, self-hosted may not.
  { ${t[@]+"${t[@]}"} "$@" run ${s[@]+"${s[@]}"} --model "inference/$MODEL" \
      --format json "$prompt" | tee "$raw"; } || rc=$?
  return "$rc"
}

# Run the implementation to completion, resuming across an abnormal death.
#
# A run can be killed from INSIDE the sandbox: the agent's own shell commands
# share a process group and a uid with opencode itself, so a hung command that
# gets group-killed on tool timeout, or a stray `pkill`, takes the agent process
# down mid-task (observed: a run died by SIGTERM at 25 of its 60 minutes after
# the agent backgrounded a mock server twice). Nothing here can prevent that —
# the kill is legal at the kernel level and the tool boundary is opencode's, not
# ours — so treat it as survivable instead: opencode persists the session, and
# `run --session <id>` picks it up with the context and the on-disk work intact.
# The resume prompt tells the agent what killed it and to change direction
# (prompts/implement-resume.tmpl).
#
# Only a signal death is resumed. 124/137 mean OUR `timeout` ended the run, so
# the budget is spent and there is nothing left to resume into; an error event
# is a model/API failure that re-running would only pay for twice.
#
# What does NOT change: a run that never recovers still fails the step, so
# deliver never runs and nothing is committed. A resume buys the agent a chance
# to FINISH — it is not a way to salvage half-done work.
oc_stream() {
  local attempt=0 rc=0 raw sid="" prompt="$AGENT_PROMPT" budget signal
  local started="$SECONDS"

  while :; do
    raw="$RAW"; [ "$attempt" -gt 0 ] && raw="$RAW.resume$attempt"
    # Each attempt gets what is LEFT of the one wall-clock bound, so resuming
    # extends the agent's chances, never its runtime.
    budget=$(( RUN_TIMEOUT - (SECONDS - started) ))
    if [ "$budget" -le 0 ]; then
      echo "::error::implementation budget (${RUN_TIMEOUT}s) exhausted before the run could finish"; return 1
    fi

    rc=0; oc_launch "$budget" "$raw" "$prompt" "$sid" "$@" || rc=$?

    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "::error::opencode exceeded the ${RUN_TIMEOUT}s implementation timeout (silent upstream retries?)"; return 1
    fi

    # rc >= 128: killed by signal rc-128 (143 = SIGTERM, the observed case).
    if [ "$rc" -lt 128 ] || [ "$attempt" -ge "$RESUME_TRIES" ]; then break; fi

    signal=$(( rc - 128 ))
    [ -n "$sid" ] || sid="$(session_of "$raw")"
    if [ -z "$sid" ]; then
      echo "::error::opencode was killed by signal $signal before emitting a session id — cannot resume"; return 1
    fi
    attempt=$(( attempt + 1 ))
    echo "::warning::opencode was killed by signal $signal — resuming session $sid (attempt $((attempt + 1)) of $((RESUME_TRIES + 1)))"
    prompt="$(render_template "$PROMPTS_DIR/implement-resume.tmpl" "SIGNAL=$signal")"
  done

  if [ "$rc" -ge 128 ]; then
    echo "::error::opencode was killed by signal $((rc - 128)) and did not recover — nothing is committed"; return 1
  fi
  # The LAST attempt's stream is the one that decides: opencode EXITS 0 EVEN
  # WHEN THE MODEL ERRORS — a non-retryable failure (e.g. a bad model id -> 400
  # model_not_found) appears only as a top-level {"type":"error"} event.
  # Trusting the exit code alone would let a broken model silently "succeed"
  # with no work done.
  if grep -q '"type":"error"' "$raw" 2>/dev/null; then
    echo "::error::opencode ended with an error event"
    grep -o '"type":"error".*' "$raw" | head -5 >&2
    return 1
  fi
  return "$rc"
}

# Create the sudo-less sandbox user (see header) and give it access to the
# working tree: ownership of the tree itself, plus traversal of the path
# leading to it.
setup_sandbox_user() {
  id -u "$OC_USER" >/dev/null 2>&1 || sudo useradd -m "$OC_USER"

  # Restore ownership on exit (even if the run fails) so deliver.sh, running as
  # the runner, can push.
  RUNNER_OWNER="$(id -u):$(id -g)"
  trap 'sudo chown -R "$RUNNER_OWNER" "$REPO_ROOT" 2>/dev/null || true' EXIT
  sudo chown -R "$OC_USER" "$REPO_ROOT"

  # chown hands agentuser the tree, but it must also TRAVERSE the path leading
  # to it: a freshly created user shares no group with the runner and the
  # runner's home is not world-traversable, so agentuser cannot reach — read or
  # write — the workspace it now owns (opencode.json, the checkout, its data dir
  # all EACCES). Grant execute-only (traverse, not list/read) on each ancestor
  # up to /. This exposes no file contents and cannot reach the proxy's process
  # environ (uid-protected, not filesystem), so the wallet key stays isolated.
  local d
  d="$(dirname "$REPO_ROOT")"
  while [ "$d" != "/" ]; do sudo chmod o+x "$d" 2>/dev/null || true; d="$(dirname "$d")"; done
}

# The isolated run: opencode as agentuser, with a clean environment.
run_sandboxed() {
  setup_sandbox_user
  echo "=== opencode implementation run (model: $MODEL, sandboxed as $OC_USER) ==="
  # env -i: no inherited env reaches the sandbox. opencode gets only a clean
  # allowlist — HOME, the runner PATH (so node/opencode resolve from the tool
  # cache), the local proxy URL, the model list, its config dir, and the runtime
  # flags above. No GH_TOKEN, no secrets (this step is granted none anyway).
  # oc_stream appends `run --format json` and the prompt, bounds the run with a
  # wall-clock timeout, and renders the event stream (see above).
  oc_stream sudo -u "$OC_USER" env -i \
    HOME="/home/$OC_USER" \
    PATH="$PATH" \
    PROXY_BASE="$PROXY_BASE" \
    INFERENCE_MODEL="${INFERENCE_MODEL:-}" \
    OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR" \
    "${OC_FLAGS[@]}" \
    "$OC_BIN"
}

# Fallback for a runner without passwordless sudo: same run, no uid boundary.
run_unsandboxed() {
  echo "::warning::passwordless sudo unavailable — running opencode WITHOUT the unprivileged-user sandbox (self-hosted runner?). The wallet key relies on the proxy not being same-uid readable."
  echo "=== opencode implementation run (model: $MODEL, UNSANDBOXED) ==="
  # GH_TOKEN scrubbed for good measure (this step is not granted one anyway).
  oc_stream env -u GH_TOKEN "${OC_FLAGS[@]}" "$OC_BIN"
}

if sudo -n true 2>/dev/null; then
  run_sandboxed
else
  run_unsandboxed
fi
