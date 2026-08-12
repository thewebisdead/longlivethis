#!/usr/bin/env bash
# FROZEN at init — shared helpers for the split agent loop.
#
# The agent loop runs as a sequence of separate workflow steps (select →
# sanitize → branch → implement → deliver), each a distinct process. This
# file, sourced by every step, gives them a common repo root, a state
# directory that carries values from one step to the next, and a dependency-
# free template renderer. No credentials and no spend keys are ever handled
# here.
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$AGENT_DIR/../../.." && pwd)"
PROMPTS_DIR="$AGENT_DIR/prompts"
cd "$REPO_ROOT"

# require_models / require_model — the configured inference models, or abort.
#
# The model ids live ONLY in the INFERENCE_MODEL repo variable (set at init,
# passed in by agent.yml). Nothing here or in lib/constants.mjs hardcodes a
# fallback: when a model is retired the fix is to edit that one variable, and a
# baked-in default would just let runs limp along on a stale id.
#
# INFERENCE_MODEL may be a comma-separated priority list (the proxy retries down
# it). require_models prints every entry, one per line, in priority order — this
# is the full set the proxy is willing to spend on, so it is also the set the
# agent may pick from. require_model prints just the first (the primary).
require_models() {
  local list
  list="$(printf '%s' "${INFERENCE_MODEL:-}" | tr ',' '\n' \
    | awk '{ gsub(/[[:space:]]/, ""); if (length) print }')"
  if [ -z "$list" ]; then
    echo "::error::INFERENCE_MODEL is unset. Set the INFERENCE_MODEL repo variable" >&2
    echo "  (Settings → Secrets and variables → Actions → Variables), e.g." >&2
    echo "  gh variable set INFERENCE_MODEL --body 'anthropic/claude-sonnet-5'" >&2
    exit 1
  fi
  printf '%s\n' "$list"
}

require_model() {
  local list
  # require_models runs in a subshell, so its `exit 1` only ends that subshell —
  # the caller must propagate the status itself.
  list="$(require_models)" || exit 1
  printf '%s' "${list%%$'\n'*}"
}

# Shared jq defs (claim_re, net_votes). Prepend onto any jq -c/-n program that
# uses them: jq -c --arg ... "$JQ_LIB"'<program>'. See lib.jq for the defs.
JQ_LIB="$(cat "$AGENT_DIR/lib.jq")"

# One directory carries state across the workflow's separate steps. agent.yml
# points AGENT_STATE at $RUNNER_TEMP; a local run falls back to /tmp.
STATE_DIR="${AGENT_STATE:-${RUNNER_TEMP:-/tmp}/longlive-agent-state}"
mkdir -p "$STATE_DIR"

# state_put KEY   — writes stdin to the state file KEY.
# state_get KEY   — prints the state file KEY (empty if unset). Used inside
#                   $(...), which strips the trailing newline either way, so
#                   callers may write with or without one.
state_put() { cat > "$STATE_DIR/$1"; }
state_get() { [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true; }

# sanitize_text "TEXT"   — prints the single cleaned copy of an untrusted
# proposal used everywhere downstream (constitution gate, implementation prompt,
# branch slug, PR title/body).
#
# ONE RULE, an allowlist: keep ASCII letters, digits, space, and the punctuation
#     . , : ; ! ? ' " ( ) - _ / @ & % + = *
# turn EVERYTHING else into a space, squeeze runs of spaces, cut to 4000
# characters, trim the ends. The result is one line of plain ASCII.
#
# What that buys, without a single special case:
#   - always valid UTF-8 (it is ASCII), so jq --arg, the prompts and the PR body
#     can never receive a broken byte sequence, and the 4000-char cut can never
#     land inside a multi-byte character;
#   - no control bytes, no NUL, no ESC;
#   - no "#", so quoted proposal text cannot smuggle an issue reference — only
#     deliver.sh's own "Closes #N" line may close or claim a proposal;
#   - no newline, so the text cannot forge structure inside a prompt;
#   - no shell/markdown/HTML/template metacharacters (` $ \ | < > { } ^ ~ #),
#     so it stays inert in the prompt templates, the branch slug and the PR body.
# Anything a legitimate proposal needs — prose, numbers, URLs — survives.
#
# Idempotent: sanitize_text "$(sanitize_text X)" == sanitize_text X. Called
# before the constitution gate (select-proposal.sh) AND in sanitize.sh, so the
# gate screens exactly the text the implementer receives.
sanitize_text() {
  local -x LC_ALL=C   # byte-wise tr/cut, so "character" means "ASCII byte"
  printf '%s' "$1" \
    | tr -c "A-Za-z0-9 .,:;!?'\"()_/@&%+=*-" ' ' \
    | tr -s ' ' \
    | cut -c1-4000 \
    | sed -E 's/^ //; s/ $//'
}

# render_template FILE KEY=VALUE...   — prints FILE with each {{KEY}} replaced
# by VALUE. Pure bash substitution (no sed/regex), so values containing
# slashes, ampersands, or backslashes — e.g. untrusted proposal text — pass
# through literally.
render_template() {
  local tmpl content kv key val
  tmpl="$1"; shift
  content="$(cat "$tmpl")"
  for kv in "$@"; do
    key="${kv%%=*}"; val="${kv#*=}"
    content="${content//\{\{$key\}\}/$val}"
  done
  printf '%s' "$content"
}

# Set a workflow step output when running under Actions (no-op locally).
step_output() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT" || true; }
