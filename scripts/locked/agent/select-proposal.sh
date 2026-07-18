#!/usr/bin/env bash
# FROZEN at init — step 1: fetch + rank proposals, run the constitution gate.
#
# Fetches open proposal issues authored by the app identity, ranks them by net
# votes (👍 − 👎), skips claimed/net-negative ones, then screens candidates in
# order against constitution.md via the payment proxy (no spend keys here —
# inference is paid by the proxy started in agent.yml). The first ALLOW wins;
# DENY issues are closed. On success writes proposal_id + proposal_text to the
# shared state and sets the `selected` step output; exits 0 with selected=false
# when nothing is eligible or nothing passes, nonzero only when inference fails.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

: "${PROXY_BASE:?PROXY_BASE is required (x402 payment proxy, started by agent.yml)}"
: "${GH_TOKEN:?GH_TOKEN is required (GitHub App installation token)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
PROPOSAL_CREATOR="${PROPOSAL_CREATOR:-${GITHUB_REPOSITORY%%/*}}"
# INFERENCE_MODEL may be a comma-separated priority list; the gate needs one id.
INFERENCE_MODEL_PRIMARY="$(printf '%s' "${INFERENCE_MODEL:-anthropic/claude-sonnet-4.6}" | cut -d, -f1 | tr -d '[:space:]')"
GATE_MODEL="${GATE_MODEL:-$INFERENCE_MODEL_PRIMARY}"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) select-proposal start ==="

# --- Fetch + rank proposals (net votes; claimed/negative skipped) -----------

# Only PRs authored by the agent's own identity can claim or reference a
# proposal: on a public repo anyone can fork and open a PR starting with
# "Closes #N", and an unauthored claim would freeze that proposal forever.
# The agent's PRs are authored by the GitHub App bot — agent.yml passes that
# identity as AGENT_PR_AUTHOR (PROPOSAL_CREATOR is the issue author, which a
# repo variable may point elsewhere). gh reports bot authors as "app/<slug>";
# normalize both sides to the bare slug before comparing.
CREATOR_BASE="${AGENT_PR_AUTHOR:-$PROPOSAL_CREATOR}"
CREATOR_BASE="${CREATOR_BASE%\[bot\]}"
OPEN_PR_BODIES=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open \
  --json body,author 2>/dev/null \
  | jq -c --arg base "$CREATOR_BASE" \
      '[ .[]
         | select(((.author.login // "") | sub("^app/"; "") | sub("\\[bot\\]$"; "")) == $base)
         | .body // "" ]' 2>/dev/null || echo "[]")

ISSUES_JSON=$(gh api "repos/${GITHUB_REPOSITORY}/issues?creator=${PROPOSAL_CREATOR}&state=open&per_page=100" 2>/dev/null || echo "[]")

# Net votes must match app/src/lib/github.ts mapIssue: 👍 ("+1") minus
# 👎 ("-1"), other emojis ignored; net-negative proposals are never built.
# An issue counts as claimed only when an open PR body STARTS with
# "Closes #N" — exactly the line deliver.sh writes at PR creation. A bare
# "#N" elsewhere (e.g. inside quoted proposal text) claims nothing, so a
# proposal listing issue numbers cannot freeze the queue. A PR closing
# unmerged frees its issue automatically.
PROPOSALS_JSON=$(jq -c --argjson claimed "$OPEN_PR_BODIES" '
  [ .[]
    | select(.pull_request == null)
    | { id: .number,
        text: ((((.body // "") | sub("^\\s+"; "") | sub("\\s+$"; ""))) as $b
               | if $b == "" then .title else $b end),
        votes: ((.reactions["+1"] // 0) - (.reactions["-1"] // 0)),
        created_at }
    | select(.votes >= 0)
    | select(.id as $id | ($claimed | any(test("(?i)^\\s*closes #\($id)\\b"))) | not)
  ] | sort_by(-.votes, -(.created_at | fromdateiso8601))
' <<<"$ISSUES_JSON" 2>/dev/null || echo "[]")

COUNT=$(jq 'length' <<<"$PROPOSALS_JSON")
if [ "$COUNT" = "0" ]; then
  echo "No eligible proposals. Skipping."
  step_output selected false
  exit 0
fi
echo "Fetched $COUNT eligible proposal issues by ${PROPOSAL_CREATOR} (ranked by net reactions)."

# --- Constitution gate (inference via the payment proxy; no keys) -----------

GATE_SYSTEM="$(cat "$PROMPTS_DIR/constitution-system.txt")"
CONSTITUTION="$(cat constitution.md)"

# → "ALLOW", "DENY: <reason>" or "SKIP: …"; nonzero when inference fails.
constitution_verdict() { # $1 = sanitized proposal text
  local user payload resp reply deny allow
  user="$(render_template "$PROMPTS_DIR/constitution-user.tmpl" \
    "CONSTITUTION=$CONSTITUTION" "PROPOSAL=$1")"
  payload=$(jq -n --arg m "$GATE_MODEL" --arg s "$GATE_SYSTEM" --arg u "$user" '{
    model: $m, temperature: 0, max_tokens: 64,
    messages: [ { role: "system", content: $s }, { role: "user", content: $u } ]
  }')
  resp=$(curl -s --max-time 180 -X POST "$PROXY_BASE/chat/completions" \
    -H 'Content-Type: application/json' -d "$payload") || return 1
  reply=$(jq -r '(.data // .) | .choices[0].message.content // empty' <<<"$resp" 2>/dev/null || true)
  if [ -z "$reply" ]; then
    echo "gate: unexpected inference response: $(head -c 300 <<<"$resp")" >&2
    return 1
  fi
  # Fail-closed parse: ANY "DENY:" line wins over any "ALLOW", so a proposal
  # that injects a trailing "ALLOW" cannot override a real DENY. Only a reply
  # with an ALLOW line and no DENY line passes; anything else is SKIP (left
  # open, never built).
  deny=$(grep -iE '^[[:space:]]*DENY:' <<<"$reply" | head -1 | sed -E 's/^[[:space:]]+//' || true)
  allow=$(grep -iE '^[[:space:]]*ALLOW\b' <<<"$reply" | head -1 || true)
  if [ -n "$deny" ]; then
    printf '%s' "$deny" | sed -E 's/^[Dd][Ee][Nn][Yy]:/DENY:/'
  elif [ -n "$allow" ]; then
    printf 'ALLOW'
  else
    printf 'SKIP: unparseable verdict'
  fi
}

PROPOSAL_ID=""
PROPOSAL_TEXT=""
for i in $(seq 0 $((COUNT - 1))); do
  CAND_ID=$(jq -r ".[$i].id" <<<"$PROPOSALS_JSON")
  CAND_VOTES=$(jq -r ".[$i].votes" <<<"$PROPOSALS_JSON")
  # Sanitize BEFORE the gate so the constitution check screens exactly the text
  # the implementer will receive (sanitize.sh re-cleans idempotently later).
  CAND_TEXT=$(sanitize_text "$(jq -r ".[$i].text" <<<"$PROPOSALS_JSON")")
  echo "--- Screening #$((i + 1)): id=$CAND_ID votes=$CAND_VOTES ---"
  echo "Text: $CAND_TEXT"

  if ! VERDICT=$(constitution_verdict "$CAND_TEXT"); then
    echo "Verdict: ERROR (inference failed) — aborting agent run."
    exit 1
  fi
  echo "Verdict: $VERDICT"

  if [ "$VERDICT" = "ALLOW" ]; then
    PROPOSAL_ID="$CAND_ID"
    PROPOSAL_TEXT="$CAND_TEXT"
    echo "Selected proposal id=$PROPOSAL_ID"
    break
  fi
  case "$VERDICT" in
    DENY:*)
      echo "Denied — closing issue #$CAND_ID."
      gh issue close "$CAND_ID" --repo "$GITHUB_REPOSITORY" \
        --reason "not planned" \
        --comment "Closed by the constitution gate. ${VERDICT}" \
        || echo "::warning::Could not close issue #$CAND_ID"
      ;;
    *)
      echo "No clear verdict — leaving issue open."
      ;;
  esac
  echo "Trying next."
done

if [ -z "$PROPOSAL_ID" ]; then
  echo "No proposal passed the constitution gate. Skipping build."
  step_output selected false
  exit 0
fi

printf '%s' "$PROPOSAL_ID"   | state_put proposal_id
printf '%s' "$PROPOSAL_TEXT" | state_put proposal_text
step_output selected true
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) select-proposal done (id=$PROPOSAL_ID) ==="
