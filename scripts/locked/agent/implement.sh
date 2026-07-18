#!/usr/bin/env bash
# FROZEN at init — step 4: run the implementation.
#
# A single frozen Pi run. There is no agent-owned implementation layer, so
# nothing here can be broken into bricking the loop. The prompt
# (prompts/implement.tmpl) carries the proposal and the few non-negotiable
# reminders; Pi also reads the repo's AGENTS.md automatically — that is where
# users tune style, extra rules, and approach.
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
# runner has passwordless sudo. So the untrusted Pi run is dropped to a
# distinct, sudo-less user (piuser) that shares no uid with the proxy and holds
# no capabilities: it cannot read the proxy's environ/mem, so the wallet key is
# unreachable no matter what a proposal instructs Pi to do.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

: "${PROXY_BASE:?PROXY_BASE is required (x402 payment proxy)}"
# The one model knob: INFERENCE_MODEL is a comma-separated priority list. Pi
# runs the first; the proxy retries down the rest on provider errors. Set the
# INFERENCE_MODEL secret to change it.
MODEL="$(printf '%s' "${INFERENCE_MODEL:-anthropic/claude-sonnet-4.6}" | cut -d, -f1 | tr -d '[:space:]')"

PROPOSAL_TEXT="$(state_get proposal_sanitized)"
BRANCH="$(state_get branch)"
PRIOR_SECTION="$(state_get prior_section)"
[ -n "$BRANCH" ] || { echo "implement: no branch in state — nothing to do" >&2; exit 1; }

PI_PROMPT="$(render_template "$PROMPTS_DIR/implement.tmpl" \
  "PROPOSAL_TEXT=$PROPOSAL_TEXT" "BRANCH=$BRANCH" "PRIOR_SECTION=$PRIOR_SECTION")"

# Register the proxy as an OpenAI-style provider for Pi (cost 0 — the proxy has
# already paid the x402 charge).
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$REPO_ROOT/.pi-agent}"
mkdir -p "$PI_CODING_AGENT_DIR"
jq -n --arg base "$PROXY_BASE" --arg m "$MODEL" '{
  providers: { x402gate: {
    baseUrl: $base, api: "openai-completions", apiKey: "x402",
    models: [{ id: $m, name: $m, reasoning: false, input: ["text"],
               contextWindow: 128000, maxTokens: 16384,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
  } }
}' > "$PI_CODING_AGENT_DIR/models.json"

# --- Run Pi as an unprivileged sandbox user (see header) -------------------
# Assumes GitHub-hosted ubuntu-latest: the runner has passwordless sudo and the
# proxy runs as the runner user. On a self-hosted runner without passwordless
# sudo the isolation cannot be established; rather than fail the loop we run Pi
# as the current user and warn loudly (no silent security downgrade).
PI_BIN="$(command -v pi)"
PI_USER=piuser

# Run Pi ("$@" is the launcher: sudo/env wrapper + "$PI_BIN --provider … --model …")
# and stream its full activity to the CI log. Pi's text --print mode emits only
# the final message; --mode json streams every event (assistant text, tool calls
# + results) as one JSON object per line — printed raw. The stream is also kept
# in $RAW because json mode exits 0 even when the model errors, so we detect a
# stopReason=error from it and fail the step ourselves.
# --no-session: one-shot run — Pi stays in memory, no on-disk session dir.
RAW="${RUNNER_TEMP:-/tmp}/pi-events.jsonl"
pi_stream() {
  local rc=0
  { "$@" --api-key x402 --no-session --mode json "$PI_PROMPT" | tee "$RAW"; } || rc=$?
  if grep -q '"stopReason":"error"' "$RAW" 2>/dev/null; then
    echo "::error::Pi ended with an error (stopReason=error)"; return 1
  fi
  return "$rc"
}

if sudo -n true 2>/dev/null; then
  id -u "$PI_USER" >/dev/null 2>&1 || sudo useradd -m "$PI_USER"

  # Hand the working tree to the sandbox user and restore ownership on exit
  # (even if Pi fails) so deliver.sh, running as the runner, can push its work.
  RUNNER_OWNER="$(id -u):$(id -g)"
  trap 'sudo chown -R "$RUNNER_OWNER" "$REPO_ROOT" 2>/dev/null || true' EXIT
  sudo chown -R "$PI_USER" "$REPO_ROOT"

  # chown hands piuser the tree, but it must also TRAVERSE the path leading to
  # it: a freshly created user shares no group with the runner and the runner's
  # home is not world-traversable, so piuser cannot reach — read or write — the
  # workspace it now owns (models.json, the checkout, its session dir all EACCES).
  # Grant execute-only (traverse, not list/read) on each ancestor up to /. This
  # exposes no file contents and cannot reach the proxy's process environ
  # (uid-protected, not filesystem), so the wallet key stays isolated.
  d="$(dirname "$REPO_ROOT")"
  while [ "$d" != "/" ]; do sudo chmod o+x "$d" 2>/dev/null || true; d="$(dirname "$d")"; done

  echo "=== Pi implementation run (model: $MODEL, sandboxed as $PI_USER) ==="
  # env -i: no inherited env reaches the sandbox. Pi gets only a clean allowlist
  # — HOME, the runner PATH (so node/pi resolve from the tool cache), the local
  # proxy URL, the model list, and its in-workspace config dir. No GH_TOKEN, no
  # secrets (this step is granted none anyway). pi_stream appends the api-key,
  # --no-session, and --mode json, and renders the event stream (see above).
  pi_stream sudo -u "$PI_USER" env -i \
    HOME="/home/$PI_USER" \
    PATH="$PATH" \
    PROXY_BASE="$PROXY_BASE" \
    INFERENCE_MODEL="${INFERENCE_MODEL:-}" \
    PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
    "$PI_BIN" --provider x402gate --model "$MODEL"
else
  echo "::warning::passwordless sudo unavailable — running Pi WITHOUT the unprivileged-user sandbox (self-hosted runner?). The wallet key relies on the proxy not being same-uid readable."
  echo "=== Pi implementation run (model: $MODEL, UNSANDBOXED) ==="
  # GH_TOKEN scrubbed for good measure (this step is not granted one anyway).
  pi_stream env -u GH_TOKEN "$PI_BIN" --provider x402gate --model "$MODEL"
fi
