#!/usr/bin/env bash
# FROZEN at init — step 4: run the implementation.
#
# A single frozen opencode run. There is no agent-owned implementation layer, so
# nothing here can be broken into bricking the loop. The prompt
# (prompts/implement.tmpl) carries the proposal and the few non-negotiable
# reminders; opencode also reads the repo's AGENTS.md automatically — that is
# where users tune style, extra rules, and approach.
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

PROPOSAL_TEXT="$(state_get proposal_sanitized)"
BRANCH="$(state_get branch)"
PRIOR_SECTION="$(state_get prior_section)"
[ -n "$BRANCH" ] || { echo "implement: no branch in state — nothing to do" >&2; exit 1; }

AGENT_PROMPT="$(render_template "$PROMPTS_DIR/implement.tmpl" \
  "PROPOSAL_TEXT=$PROPOSAL_TEXT" "BRANCH=$BRANCH" "PRIOR_SECTION=$PRIOR_SECTION")"

# Register the proxy as an OpenAI-compatible provider (cost 0 — the proxy has
# already paid the x402 charge). @ai-sdk/openai-compatible is compiled into the
# opencode binary, so naming it here pulls nothing from a registry at run time.
# PROXY_BASE already ends in /v1 (x402gate.mjs publishes it that way and
# agent.yml reads it straight from the port file) — do not append it again.
# The context/output limits are stated explicitly because models.dev has no
# entry for a private "x402gate" provider — the catalogue opencode downloads at
# startup describes public providers, never this one, so without these
# autocompact would have nothing to work from for the base model.
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$REPO_ROOT/.opencode-agent}"
mkdir -p "$OPENCODE_CONFIG_DIR"
jq -n --arg base "$PROXY_BASE" --arg m "$MODEL" '{
  "$schema": "https://opencode.ai/config.json",
  provider: { x402gate: {
    npm: "@ai-sdk/openai-compatible", name: "x402gate",
    options: { baseURL: $base, apiKey: "x402" },
    models: { ($m): { name: $m, limit: { context: 128000, output: 16384 },
                      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }
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
# stream is also kept in $RAW because opencode EXITS 0 EVEN WHEN THE MODEL
# ERRORS: a non-retryable failure (e.g. a bad model id -> 400 model_not_found)
# appears only as a top-level {"type":"error"} event in the stream. Trusting the
# exit code alone would let a broken model silently "succeed" with no work done.
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
  TIMEOUT_CMD=(timeout --signal=INT --kill-after=60 "$RUN_TIMEOUT")
else
  echo "::warning::coreutils 'timeout' not found — running opencode WITHOUT a wall-clock bound; a silently-retrying upstream error will hang until the job timeout."
  TIMEOUT_CMD=()
fi

oc_stream() {
  local rc=0
  # ${arr[@]+"${arr[@]}"}: expands to nothing when TIMEOUT_CMD is empty without
  # tripping `set -u` on bash 3.2 (macOS); runners ship bash 5, self-hosted may not.
  { ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} "$@" run --model "x402gate/$MODEL" \
      --format json "$AGENT_PROMPT" | tee "$RAW"; } || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "::error::opencode exceeded the ${RUN_TIMEOUT}s implementation timeout (silent upstream retries?)"; return 1
  fi
  if grep -q '"type":"error"' "$RAW" 2>/dev/null; then
    echo "::error::opencode ended with an error event"
    grep -o '"type":"error".*' "$RAW" | head -5 >&2
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
