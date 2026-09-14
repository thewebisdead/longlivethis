#!/usr/bin/env bash
# FROZEN at init — step 4: run the implementation.
#
# A single frozen Pi run. There is no agent-owned implementation layer, so
# nothing here can be broken into bricking the loop.
#
# The agent's instructions come from two places. prompts/implement.tmpl is
# FROZEN and carries everything non-negotiable: the proposal, the sandbox it is
# running in, the run contract, the frozen-path list, and the life-support
# rules. The repo's AGENTS.md, which Pi reads automatically, carries only
# user-tunable advice — style, capabilities, layout. The template states that it
# outranks AGENTS.md, so an emptied, corrupted or hostile AGENTS.md costs the
# run advice, never the rules; nothing here depends on that file existing.
#
# Runs with NO credentials: GH_TOKEN is never set on this step, and no wallet
# key exists in this environment — inference is paid only through the proxy.
# Enforcement lives in the frozen substrate (CI gates, credential scrubbing,
# the freeze), not in this prompt, so a mutable AGENTS.md weakens no guarantee.
#
# TOOLS. Pi's built-ins are read/bash/edit/write/ls/find/grep. Two layers add to
# them, matching the repo's own frozen/mutable split:
#   - extensions/webfetch.ts, loaded with -e below: FROZEN, always present, and
#     the reason the agent can read documentation instead of guessing.
#   - .pi/extensions/ in the repo: the AGENT's own, added by a normal proposal
#     and PR like any other feature. Pi auto-discovers them, which is why the
#     run passes --approve (see below). Nothing here enumerates them: a tool the
#     agent needs next is a commit, not a change to this frozen file.
#
# That second layer is agent-owned code loaded into the agent's own process, so
# it is the one thing here that could BRICK the loop: an extension that throws
# on load makes Pi exit before its first request, and nothing in CI runs Pi, so
# a broken one merges and then kills every later sweep the same way. pi_stream
# therefore degrades instead — a startup failure is retried once with
# --no-extensions, which drops the repo's extensions and keeps the frozen -e
# webfetch. A bad extension costs the agent its own tools for that run, never
# the loop.
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
# Pi runs the first; the proxy retries down the rest on provider errors.
# It comes from the INFERENCE_MODEL repo variable — change it there (no code
# change) when a model is retired.
MODEL="$(require_model)"

# Wall-clock bound on the run. Pi retries retryable upstream errors (500/429/
# 503, connection refused) with escalating backoff; an unbounded run would hang
# to the job timeout. Overridable for slow features; the cap is on the agent's
# own runtime, not on the proposal.
RUN_TIMEOUT="${IMPLEMENT_TIMEOUT:-3600}"

# How many times a run that DIED BY SIGNAL is resumed (see pi_stream). One by
# default: enough to survive a self-inflicted kill, not enough to burn the
# budget re-running the same fatal command. 0 disables resuming entirely.
RESUME_TRIES="${IMPLEMENT_RESUMES:-1}"

PROPOSAL_TEXT="$(state_get proposal_sanitized)"
BRANCH="$(state_get branch)"
PRIOR_SECTION="$(state_get prior_section)"
[ -n "$BRANCH" ] || { echo "implement: no branch in state — nothing to do" >&2; exit 1; }

AGENT_PROMPT="$(render_template "$PROMPTS_DIR/implement.tmpl" \
  "PROPOSAL_TEXT=$PROPOSAL_TEXT" "BRANCH=$BRANCH" "PRIOR_SECTION=$PRIOR_SECTION")"

export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$REPO_ROOT/.pi-agent}"
SESSION_DIR="$PI_CODING_AGENT_DIR/sessions"
mkdir -p "$PI_CODING_AGENT_DIR" "$SESSION_DIR"

# --- Provider config, taken from the proxy's own catalogue -------------------
# Register the proxy as an OpenAI-style provider (cost 0 — the proxy has already
# paid the x402 charge). PROXY_BASE already ends in /v1 (inference-proxy.mjs
# publishes it that way and agent.yml reads it straight from the port file) — do
# not append it again.
#
# The model list is FETCHED FROM THE PROXY rather than derived here a second
# time. GET /v1/models answers from the proxy's own INFERENCE_MODEL, i.e. the
# exact set of ids it is willing to route and pay for, so what the agent can see
# is what it can actually reach — and naming a sibling model (handing a cheap
# subtask to a smaller one) needs no change here. The two processes read that
# variable from separate env blocks in agent.yml, so they CAN disagree; the
# check below turns that from a mid-run 400 into an immediate, named failure.
#
# The provider is named "inference", not after whichever gateway is paying:
# which gateway that is comes from the INFERENCE_PROVIDER repo variable and can
# change without the agent's model ids ("inference/<model>") changing with it.
#
# The context/output limits are stated explicitly because a private provider
# appears in no public model catalogue — without them Pi's compaction would have
# nothing to work from. Pi runs with PI_OFFLINE=1 (see PI_FLAGS), so the proxy's
# answer is the ONLY catalogue in the run: no startup fetch, no remote model
# store, nothing that could offer the agent a model the proxy will not pay for.
CATALOGUE="$(curl -fsS --max-time 30 "$PROXY_BASE/models")" || {
  echo "::error::could not read the model catalogue from the payment proxy ($PROXY_BASE/models)"; exit 1; }

jq -e --arg m "$MODEL" '[.data[].id] | index($m)' >/dev/null <<<"$CATALOGUE" || {
  echo "::error::the proxy will not route '$MODEL' — it serves [$(jq -r '[.data[].id]|join(", ")' <<<"$CATALOGUE")]."
  echo "::error::the proxy and this step read INFERENCE_MODEL separately; check the repo variable."
  exit 1
}

jq --arg base "$PROXY_BASE" '{
  providers: { inference: {
    name: "inference", baseUrl: $base, api: "openai-completions", apiKey: "x402",
    models: [ .data[] | {
      id: .id, name: .id, reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    } ]
  } }
}' <<<"$CATALOGUE" > "$PI_CODING_AGENT_DIR/models.json"

# --- Retry policy -----------------------------------------------------------
# retry.provider.maxRetries is 0 by default, which means Pi IGNORES a server's
# Retry-After and falls back to its own 2s/4s/8s backoff — it gives up on a busy
# gateway in about fifteen seconds. That would quietly undo the proxy's payment
# backpressure: it answers a payment that cannot go through yet with
# 429 + Retry-After (see inference-proxy.mjs — a 402 would end the session
# outright), which only helps if the client actually waits. Enabling SDK-level
# retries makes Pi honour the header, turning a locked channel into a pause
# instead of a dead run. The documented cost is that provider-level retries also
# absorb usage-limit errors before Pi sees them; here the only provider is the
# proxy, whose 429 IS the backpressure signal, so that is exactly what we want.
# maxRetryDelayMs caps how long a single server-requested wait may be.
#
# defaultTools restores ls/find/grep alongside the default read/bash/edit/write:
# they are built in but off by default, and an agent without them does the same
# work through bash with worse output.
cat > "$PI_CODING_AGENT_DIR/settings.json" <<'JSON'
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": { "maxRetries": 2, "maxRetryDelayMs": 60000 }
  },
  "defaultTools": ["read", "bash", "edit", "write", "ls", "find", "grep"]
}
JSON

# --- Run Pi as an unprivileged sandbox user (see header) --------------------
# Assumes GitHub-hosted ubuntu-latest: the runner has passwordless sudo and the
# proxy runs as the runner user. On a self-hosted runner without passwordless
# sudo the isolation cannot be established; rather than fail the loop we run the
# agent as the current user and warn loudly (no silent security downgrade).
PI_BIN="$(command -v pi)"
PI_USER=agentuser
WEBFETCH_EXT="$AGENT_DIR/extensions/webfetch.ts"

# The session id is generated HERE rather than read back out of the stream: a
# run killed by a signal is resumed by re-running with the same id (see
# pi_stream), and --session-id creates the session if it does not exist yet. So
# the id is known before Pi starts and survives a death that printed nothing.
SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || true)"
[ -n "$SESSION_ID" ] || { echo "::error::could not generate a session id (no /proc/sys/kernel/random/uuid, no uuidgen)"; exit 1; }

# Runtime flags, passed into the sandbox (see the env -i allowlist below).
#   PI_OFFLINE — no startup network: no update check, no remote model catalogue,
#       no install telemetry. The proxy's catalogue (above) is the only model
#       list, and the pinned version in agent.yml is the only binary. An agent
#       that could self-update could pick its own binary.
PI_FLAGS=(
  PI_OFFLINE=1
)

# Arguments every launch shares.
#   --approve         trust project-local .pi/ for this run, so the agent's own
#       extensions load. Non-interactive modes never prompt, so without it
#       .pi/extensions/ is silently ignored and an agent-authored tool would
#       vanish with no error. Nothing is conceded: an extension is TypeScript
#       running as agentuser, which is what the bash tool already offers, and
#       this step holds no credentials. A hostile .pi/settings.json can spoil
#       its own run (it may override the retry policy above) and nothing else.
#   -e webfetch.ts    the frozen default tool. Explicit -e paths load
#       independently of discovery and of project trust, so webfetch survives an
#       agent that empties or misconfigures .pi/.
#   --session-dir     sessions inside the config dir, which agentuser owns.
#       Anywhere under $HOME would be unreachable for the sandbox user.
PI_ARGS=(
  --provider inference --model "$MODEL" --api-key x402
  --approve
  -e "$WEBFETCH_EXT"
  --session-dir "$SESSION_DIR"
  --session-id "$SESSION_ID"
  --mode json
)

RAW="${RUNNER_TEMP:-/tmp}/pi-events.jsonl"
if command -v timeout >/dev/null 2>&1; then
  HAS_TIMEOUT=1
else
  echo "::warning::coreutils 'timeout' not found — running Pi WITHOUT a wall-clock bound; a silently-retrying upstream error will hang until the job timeout."
  HAS_TIMEOUT=0
fi

# Does the session hold anything to resume INTO?
#
# Pi persists a turn's messages when the turn completes, so a run killed in its
# very first turn leaves a session file with headers and no messages. Resuming
# that would hand the agent prompts/implement-resume.tmpl and nothing else — a
# prompt that says its earlier context is intact and tells it to finish the
# feature, with no proposal, no rules and no branch in front of it. Whatever
# that produced would be arbitrary, and deliver would push it.
#
# So resume only into a session that actually carries messages. (The old
# stream-scraped session id guarded this by accident: a run that died before
# printing an id could not be resumed at all. The id is generated up front now,
# so the guard has to be explicit.) Losing the run instead is the cheap side: no
# PR, the proposal stays open, the next sweep starts it cleanly.
session_has_context() {
  local f
  f="$(ls "$SESSION_DIR"/*"_$SESSION_ID.jsonl" 2>/dev/null | head -1)"
  [ -n "$f" ] || return 1
  grep -q '"type":"message"' "$f"
}

# Did the run end in a model/API failure?
#
# Pi EXITS 0 EVEN WHEN EVERY ATTEMPT FAILED, so the exit code decides nothing.
# The stream is the record: each attempt ends in an `agent_end` event carrying
# the messages so far, and the last message of the LAST agent_end says how the
# run actually finished — "stop" when it produced an answer, "error" when it did
# not. Taking the last one is what distinguishes a run that failed from one that
# RECOVERED: a transient 500 leaves an errored message behind and then succeeds,
# so grepping the stream for an error (or for stopReason "error") anywhere fails
# runs that worked, and since deliver is gated on this step, that would throw
# away finished work. Per-attempt retry events are no better — a non-retryable
# 400 emits none at all, yet is a total failure.
#
# Read line by line, never slurped: one line of an hour-long run's stream is
# already large. An empty verdict means no agent_end was ever emitted (the run
# died before producing one) — a failure too.
final_stop_reason() {
  jq -r 'select(.type == "agent_end") | (.messages // [] | last | .stopReason // "none")' "$1" 2>/dev/null | tail -1
}

# One Pi invocation: pi_launch BUDGET RAWFILE PROMPT LAUNCHER...
pi_launch() {
  local budget="$1" raw="$2" prompt="$3"; shift 3
  local rc=0
  local -a t=()
  [ "$HAS_TIMEOUT" -eq 1 ] && t=(timeout --signal=INT --kill-after=60 "$budget")
  # Two pieces of plumbing on the line below.
  #
  # ${arr[@]+"${arr[@]}"}: expands to nothing when the array is empty without
  # tripping `set -u` on bash 3.2 (macOS); runners ship bash 5, self-hosted may
  # not.
  #
  # </dev/null: the run is non-interactive, and Pi waits on an stdin that is an
  # open pipe rather than treating it as absent. A workflow step is already
  # given /dev/null, so this only shows up when someone runs the loop by hand
  # from a terminal — where it is the difference between a run and a hang.
  { ${t[@]+"${t[@]}"} "$@" "${PI_ARGS[@]}" "$prompt" </dev/null | tee "$raw"; } || rc=$?
  return "$rc"
}

# Run the implementation to completion, resuming across an abnormal death.
#
# A run can be killed from INSIDE the sandbox: the agent's own shell commands
# share a process group and a uid with Pi itself, so a hung command that gets
# group-killed on tool timeout, or a stray `pkill`, takes the agent process down
# mid-task (observed: a run died by SIGTERM at 25 of its 60 minutes after the
# agent backgrounded a mock server twice). Nothing here can prevent that — the
# kill is legal at the kernel level and the tool boundary is Pi's, not ours — so
# treat it as survivable instead: Pi persists the session as it goes, and
# re-running with the same --session-id picks it up with the context and the
# on-disk work intact. The resume prompt tells the agent what killed it and to
# change direction (prompts/implement-resume.tmpl).
#
# Only a signal death is resumed. 124/137 mean OUR `timeout` ended the run, so
# the budget is spent and there is nothing left to resume into; a model/API
# failure is not resumed either, since re-running it would only pay twice.
#
# What does NOT change: a run that never recovers still fails the step, so
# deliver never runs and nothing is committed. A resume buys the agent a chance
# to FINISH — it is not a way to salvage half-done work.
pi_stream() {
  local attempt=0 degraded=0 rc=0 raw prompt="$AGENT_PROMPT" budget signal stop
  local started="$SECONDS"

  while :; do
    raw="$RAW"; [ "$attempt" -gt 0 ] && raw="$RAW.resume$attempt"
    # Each attempt gets what is LEFT of the one wall-clock bound, so resuming
    # extends the agent's chances, never its runtime.
    budget=$(( RUN_TIMEOUT - (SECONDS - started) ))
    if [ "$budget" -le 0 ]; then
      echo "::error::implementation budget (${RUN_TIMEOUT}s) exhausted before the run could finish"; return 1
    fi

    rc=0; pi_launch "$budget" "$raw" "$prompt" "$@" || rc=$?

    # Did Pi get as far as running? Its first line of output is the session
    # header, printed before any model call, so a non-zero exit with no header
    # at all means it died during startup — in practice an extension under
    # .pi/extensions/ that throws when loaded (a bad import, a syntax error, a
    # missing dependency). Drop the repo's extensions and try once more: the
    # frozen -e webfetch still loads (explicit paths are unaffected by
    # --no-extensions), so the agent runs with the substrate's toolset and can
    # repair the extension that locked it out. Without this, one merged bad
    # extension would fail every sweep from then on and only a human could
    # clear it.
    if [ "$rc" -ne 0 ] && [ "$degraded" -eq 0 ] && ! grep -q '"type":"session"' "$raw" 2>/dev/null; then
      degraded=1
      PI_ARGS+=(--no-extensions)
      echo "::warning::Pi failed to start — retrying without the repo's .pi/extensions (the frozen webfetch tool stays). A repo extension that throws on load is the usual cause; see the error above."
      continue
    fi

    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "::error::Pi exceeded the ${RUN_TIMEOUT}s implementation timeout"; return 1
    fi

    # rc >= 128: killed by signal rc-128 (143 = SIGTERM, the observed case).
    if [ "$rc" -lt 128 ] || [ "$attempt" -ge "$RESUME_TRIES" ]; then break; fi

    signal=$(( rc - 128 ))
    if ! session_has_context; then
      echo "::error::Pi was killed by signal $signal before persisting any of the run — there is no context to resume into, so the run ends here"
      return 1
    fi
    attempt=$(( attempt + 1 ))
    echo "::warning::Pi was killed by signal $signal — resuming session $SESSION_ID (attempt $((attempt + 1)) of $((RESUME_TRIES + 1)))"
    prompt="$(render_template "$PROMPTS_DIR/implement-resume.tmpl" "SIGNAL=$signal")"
  done

  if [ "$rc" -ge 128 ]; then
    echo "::error::Pi was killed by signal $((rc - 128)) and did not recover — nothing is committed"; return 1
  fi

  stop="$(final_stop_reason "$raw")"
  if [ "$stop" != "stop" ]; then
    echo "::error::the implementation run ended without finishing (stopReason: ${stop:-no agent_end event})"
    # The upstream status and body land here, and nowhere else.
    jq -r 'select(.type == "agent_end") | (.messages // [] | last | .errorMessage // empty)' "$raw" 2>/dev/null \
      | tail -3 >&2 || true
    return 1
  fi
  return "$rc"
}

# Create the sudo-less sandbox user (see header) and give it access to the
# working tree: ownership of the tree itself, plus traversal of the path
# leading to it.
setup_sandbox_user() {
  id -u "$PI_USER" >/dev/null 2>&1 || sudo useradd -m "$PI_USER"

  # Restore ownership on exit (even if the run fails) so deliver.sh, running as
  # the runner, can push.
  RUNNER_OWNER="$(id -u):$(id -g)"
  trap 'sudo chown -R "$RUNNER_OWNER" "$REPO_ROOT" 2>/dev/null || true' EXIT
  sudo chown -R "$PI_USER" "$REPO_ROOT"

  # chown hands agentuser the tree, but it must also TRAVERSE the path leading
  # to it: a freshly created user shares no group with the runner and the
  # runner's home is not world-traversable, so agentuser cannot reach — read or
  # write — the workspace it now owns (models.json, the checkout, its session
  # dir all EACCES). Grant execute-only (traverse, not list/read) on each
  # ancestor up to /. This exposes no file contents and cannot reach the proxy's
  # process environ (uid-protected, not filesystem), so the wallet key stays
  # isolated.
  local d
  d="$(dirname "$REPO_ROOT")"
  while [ "$d" != "/" ]; do sudo chmod o+x "$d" 2>/dev/null || true; d="$(dirname "$d")"; done
}

# The isolated run: Pi as agentuser, with a clean environment.
run_sandboxed() {
  setup_sandbox_user
  echo "=== Pi implementation run (model: $MODEL, session: $SESSION_ID, sandboxed as $PI_USER) ==="
  # env -i: no inherited env reaches the sandbox. Pi gets only a clean allowlist
  # — HOME, the runner PATH (so node/pi resolve from the tool cache), the local
  # proxy URL, the model list, its config dir, and the runtime flags above. No
  # GH_TOKEN, no secrets (this step is granted none anyway). pi_stream appends
  # the shared arguments and the prompt, bounds the run with a wall-clock
  # timeout, and renders the event stream (see above).
  pi_stream sudo -u "$PI_USER" env -i \
    HOME="/home/$PI_USER" \
    PATH="$PATH" \
    PROXY_BASE="$PROXY_BASE" \
    INFERENCE_MODEL="${INFERENCE_MODEL:-}" \
    PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
    "${PI_FLAGS[@]}" \
    "$PI_BIN"
}

# Fallback for a runner without passwordless sudo: same run, no uid boundary.
run_unsandboxed() {
  echo "::warning::passwordless sudo unavailable — running Pi WITHOUT the unprivileged-user sandbox (self-hosted runner?). The wallet key relies on the proxy not being same-uid readable."
  echo "=== Pi implementation run (model: $MODEL, session: $SESSION_ID, UNSANDBOXED) ==="
  # GH_TOKEN scrubbed for good measure (this step is not granted one anyway).
  pi_stream env -u GH_TOKEN "${PI_FLAGS[@]}" "$PI_BIN"
}

if sudo -n true 2>/dev/null; then
  run_sandboxed
else
  run_unsandboxed
fi
