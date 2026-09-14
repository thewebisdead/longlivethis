#!/usr/bin/env bash
# FROZEN at init — keeps the open proposal board bounded.
#
# Every reader of the board fetches it whole: the app server-renders the feed
# on each request, and the agent ranks all of it to pick what to build. The app
# refuses new proposals once PROPOSAL_HARD_CAP (500) are open, which is what
# bounds those fetches to a known page count. This script is what keeps the
# board from ever reaching that ceiling: when more than CLEANUP_THRESHOLD
# proposals are open it keeps the top CLEANUP_KEEP_PCT% and closes the rest
# with a comment.
#
# Eviction is by RANK — the same order the agent selects with (net votes, then
# newest) — rather than by age or an absolute vote floor. That choice does a
# lot of work:
#
#   - Most proposals sit at 0 votes forever, and the newest-first tiebreak puts
#     the OLDEST of those at the bottom, so eviction drains the stale end
#     without a separate age rule to tune.
#   - One 👍 lifts a proposal above the entire 0-vote block. A flood of unvoted
#     spam can therefore only evict other unvoted proposals — largely its own,
#     since the flood is the newest thing on the board.
#   - Closing on net-negative votes alone was the obvious alternative and is
#     worse: it would make deletion cost one 👎 while creation costs a whole
#     proposal, so a single account could clear the board one downvote at a
#     time. Rank makes eviction relative, so a downvote only matters next to
#     how everything else is doing.
#   - Nothing is closed while the board is under threshold. A quiet site never
#     loses a proposal, and a proposal is only ever closed because a better one
#     needed the slot.
#
# No inference and no spend keys: this is a sort and a close loop. It runs as
# GITHUB_TOKEN with issues:write, never as the agent or proposals app.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required (issues:write)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"

# Proposals are issues opened by the app identity; issues filed by anyone else
# are not proposals and are never touched. Same default as select-proposal.sh.
PROPOSAL_CREATOR="${PROPOSAL_CREATOR:-${GITHUB_REPOSITORY%%/*}}"

THRESHOLD="${CLEANUP_THRESHOLD:-100}"
KEEP_PCT="${CLEANUP_KEEP_PCT:-80}"

# Both knobs are repo variables, so a deployment can retune the board without a
# code change — which means both arrive as untrusted strings and are validated
# before any arithmetic. A typo must stop the run, never silently evaluate to 0
# and close the entire board.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
if ! is_uint "$THRESHOLD" || [ "$THRESHOLD" -lt 1 ]; then
  echo "::error::CLEANUP_THRESHOLD must be a positive integer (got '$THRESHOLD')." >&2
  exit 1
fi
# Capped at 99 rather than 100: at 100 the kept set equals the threshold, so a
# board sitting one over would close a single proposal on every sweep forever.
# The gap between threshold and kept count is the hysteresis that stops that.
if ! is_uint "$KEEP_PCT" || [ "$KEEP_PCT" -lt 1 ] || [ "$KEEP_PCT" -gt 99 ]; then
  echo "::error::CLEANUP_KEEP_PCT must be an integer in 1..99 (got '$KEEP_PCT')." >&2
  exit 1
fi

KEEP=$(( THRESHOLD * KEEP_PCT / 100 ))
[ "$KEEP" -lt 1 ] && KEEP=1

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) cleanup-proposals start ==="
echo "Threshold $THRESHOLD, keeping top ${KEEP_PCT}% ($KEEP proposals)."

# net_votes is defined once, in the agent's jq lib, and reused here so the
# eviction ranking cannot drift from the selection ranking. If these two ever
# disagree the agent would be picking from a board pruned by a different rule.
JQ_LIB="$(cat "$(dirname "$0")/agent/lib.jq")"

# --paginate --slurp returns an ARRAY OF PAGES, so `add` flattens it back to the
# flat issue array the filters below expect (`// []` covers the no-pages case).
# Paginating matters here more than anywhere: this script is the one reader that
# must see the whole board, including the tail it is about to close.
if ! ISSUES_JSON=$(gh api --paginate --slurp \
      "repos/${GITHUB_REPOSITORY}/issues?creator=${PROPOSAL_CREATOR}&state=open&per_page=100" \
      | jq -c 'add // []'); then
  echo "::warning::Could not fetch proposals — skipping this sweep."
  exit 0
fi

# Shape and rank in one pass: PRs are not proposals, and the sort is byte-for-
# byte the one in select-proposal.sh (most net votes first, newest breaking a
# tie) so "the bottom of this list" means the same thing in both places.
RANKED_JSON=$(jq -c "$JQ_LIB"'
  [ .[]
    | select(.pull_request == null)
    | { id: .number, votes: net_votes, created_at }
  ] | sort_by(-.votes, -(.created_at | fromdateiso8601))' <<<"$ISSUES_JSON")

COUNT=$(jq 'length' <<<"$RANKED_JSON")
echo "Open proposals by ${PROPOSAL_CREATOR}: $COUNT"

if [ "$COUNT" -le "$THRESHOLD" ]; then
  echo "Under threshold — nothing to close."
  exit 0
fi

# A proposal an open PR is already implementing must not be closed out from
# under the agent mid-build. Ranking makes that rare (the agent builds from the
# top), but votes move while a PR is open.
#
# Only PRs authored by a BOT count as a claim. On a public repo anyone can open
# a PR, and an author-blind check would let a drive-by "Closes #N" pin a junk
# proposal in place indefinitely — one griefing PR per slot. select-proposal.sh
# pins this to the agent's exact app slug because a false claim there freezes a
# proposal forever; here a false claim only spares one proposal for one sweep,
# so the cheaper bot check is enough.
#
# A gh failure skips the whole sweep rather than proceeding claim-blind: the
# board being one sweep over threshold is harmless, closing a proposal that is
# actively being built is not.
if ! PR_LIST=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json body,author); then
  echo "::warning::Could not list open PRs — skipping this sweep rather than risk closing a proposal being built."
  exit 0
fi
CLAIM_BODIES=$(jq -c '
  [ .[]
    | select((.author.login // "") | test("(^app/|\\[bot\\]$)"))
    | .body // "" ]' <<<"$PR_LIST")

# Everything past the kept prefix, minus anything claimed.
VICTIMS_JSON=$(jq -c --argjson claimed "$CLAIM_BODIES" --argjson keep "$KEEP" "$JQ_LIB"'
  .[$keep:]
  | [ .[] | select(.id as $id | ($claimed | any(test(claim_re($id)))) | not) ]' <<<"$RANKED_JSON")

VICTIM_COUNT=$(jq 'length' <<<"$VICTIMS_JSON")
echo "Closing $VICTIM_COUNT proposal(s) ranked below #${KEEP}."

# The comment is the only explanation a proposer ever gets, and a proposal
# vanishing without one reads as censorship on a repo whose whole pitch is that
# the rules are public. Say what the rule was and that reproposing is fine.
while IFS= read -r victim; do
  [ -n "$victim" ] || continue
  id=$(jq -r '.id' <<<"$victim")
  votes=$(jq -r '.votes' <<<"$victim")
  echo "  closing #$id (net votes: $votes)"
  gh issue close "$id" --repo "$GITHUB_REPOSITORY" \
    --reason "not planned" \
    --comment "Closed automatically to keep the proposal board under ${THRESHOLD} open proposals.

There were ${COUNT} open, and this one ranked outside the top ${KEEP} by net votes (👍 − 👎, ties broken by newest) with a net score of ${votes}. That is a ranking decision, not a judgement about the idea — it simply did not have the support to hold a slot while the board was full.

Anyone is free to propose it again." \
    || echo "::warning::Could not close issue #$id"
done < <(jq -c '.[]' <<<"$VICTIMS_JSON")

echo "=== cleanup-proposals done ==="
