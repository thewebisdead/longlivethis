#!/usr/bin/env bash
# FROZEN at init — step 3: create the feature branch + gather prior-attempt
# context.
#
# Derives feat/<slug> from the sanitized proposal, checks out a fresh branch
# from origin/main, and — if this proposal was attempted before — collects the
# earlier branch and closed-unmerged PRs so the implementation prompt can learn
# from them. Writes branch + prior_section to the shared state.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

: "${GH_TOKEN:?GH_TOKEN is required (GitHub App installation token)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
PROPOSAL_CREATOR="${PROPOSAL_CREATOR:-${GITHUB_REPOSITORY%%/*}}"
CREATOR_BASE="${AGENT_PR_AUTHOR:-$PROPOSAL_CREATOR}"
CREATOR_BASE="${CREATOR_BASE%\[bot\]}"

PROPOSAL_ID="$(state_get proposal_id)"
PROPOSAL_TEXT="$(state_get proposal_sanitized)"
[ -n "$PROPOSAL_ID" ] || { echo "create-branch: no proposal in state" >&2; exit 1; }

SLUG=$(printf '%s' "$PROPOSAL_TEXT" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/^(please +)?(can|could) +you +//; s/^(please +)?(add|implement|create|make|build|enable|support) +//; s/\?+$//' \
  | tr -cs 'a-z0-9' '-' | sed -E 's/^-+//; s/-+$//' | cut -c1-48 | sed -E 's/-+$//')
BRANCH="feat/${SLUG:-feature}"

# An existing remote branch for this slug is an earlier attempt that never
# merged — keep its name so Pi can study it; build on a fresh suffixed branch.
PRIOR_BRANCH=""
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  PRIOR_BRANCH="$BRANCH"
  BRANCH="${BRANCH}-p${PROPOSAL_ID}"
fi
echo "Branch: $BRANCH"

# Closed-unmerged PRs that claimed this issue ("Closes #N" opening line, as
# written by deliver.sh) are earlier failed attempts. Same author filter as
# the claim check in select-proposal.sh: outsiders' PRs are not prior attempts,
# and their titles must not reach the implementation prompt.
PRIOR_PRS=$(gh pr list --repo "$GITHUB_REPOSITORY" --state closed --limit 50 \
  --json title,url,body,mergedAt,author 2>/dev/null \
  | jq -r --arg base "$CREATOR_BASE" --arg id "$PROPOSAL_ID" \
      '.[]
       | select(.mergedAt == null)
       | select(((.author.login // "") | sub("^app/"; "") | sub("\\[bot\\]$"; "")) == $base)
       | select((.body // "") | test("(?i)^\\s*closes #" + $id + "\\b"))
       | "\(.url) — \(.title)"' 2>/dev/null || true)

PRIOR_SECTION=""
if [ -n "${PRIOR_BRANCH}${PRIOR_PRS}" ]; then
  [ -n "$PRIOR_BRANCH" ] && git fetch origin "$PRIOR_BRANCH" >/dev/null 2>&1 || true
  PRIOR_SECTION="This proposal was attempted before and did not merge. BEFORE implementing,
study the earlier attempt and work out why it failed:
${PRIOR_BRANCH:+- Prior branch (fetched): origin/${PRIOR_BRANCH} — read it with
  \`git log --stat origin/${PRIOR_BRANCH}\` and \`git diff origin/main...origin/${PRIOR_BRANCH}\`.
}${PRIOR_PRS:+- Prior closed PRs:
${PRIOR_PRS}
}Reuse what was sound, avoid what broke, and make preflight pass this time."
fi

git config user.name "longlive-agent"
git config user.email "agent@users.noreply.github.com"
git fetch origin main
git checkout -B "$BRANCH" origin/main

printf '%s' "$BRANCH"         | state_put branch
printf '%s' "$PRIOR_SECTION"  | state_put prior_section
