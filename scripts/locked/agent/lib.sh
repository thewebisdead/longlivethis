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
# branch slug, PR body). It:
#   - strips ASCII control characters (keeps tab + newline),
#   - neutralizes issue references ("#12" → "# 12") so quoted proposal text can
#     never smuggle a closing keyword — only deliver.sh's own "Closes #N" line
#     may close issues or claim a proposal,
#   - trims surrounding whitespace and caps the length so an oversized proposal
#     cannot blow up the inference context or the PR body.
# Idempotent: sanitize_text "$(sanitize_text X)" == sanitize_text X. Called
# before the constitution gate (select-proposal.sh) AND in sanitize.sh, so the
# gate screens exactly the text the implementer receives.
sanitize_text() {
  printf '%s' "$1" \
    | tr -d '\000-\010\013-\037' \
    | sed -E 's/#([0-9])/# \1/g' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | head -c 4000
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
