#!/usr/bin/env bash
# FROZEN at init — step 5: deliver whatever was committed.
#
# Pushes the feature branch (commits only — the implementer must commit its own
# work) and opens an auto-merge PR whose body STARTS with "Closes #N". CI
# ("test", frozen) is the merge gate, so a broken preflight cannot brick the
# loop and broken code cannot merge. Exits nonzero when the implementation
# produced no commits (a selected proposal that yielded nothing is a failure,
# unlike an empty queue upstream).
set -euo pipefail

. "$(dirname "$0")/lib.sh"

: "${GH_TOKEN:?GH_TOKEN is required (GitHub App installation token)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"

PROPOSAL_ID="$(state_get proposal_id)"
PROPOSAL_TEXT="$(state_get proposal_sanitized)"
BRANCH="$(state_get branch)"
[ -n "$BRANCH" ] && [ -n "$PROPOSAL_ID" ] || { echo "deliver: missing state" >&2; exit 1; }

has_work() { ! git diff --quiet "origin/main...HEAD"; }
if ! has_work; then
  echo "No commits produced. Skipping push/PR."
  exit 1
fi

# Push via gh's credential helper (GH_TOKEN) so the token never appears in a
# command line / process list.
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  push "https://github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"

# PROPOSAL_TEXT is already sanitized ("#N" → "# N"), so the quoted proposal
# cannot smuggle a closing keyword — only the "Closes #N" line below may close
# issues or claim the proposal.
PR_URL=""
if PR_URL=$(gh pr create \
  --repo "$GITHUB_REPOSITORY" \
  --base main \
  --head "$BRANCH" \
  --title "feat: $(printf '%s' "$PROPOSAL_TEXT" | head -c 200 | tr '\n' ' ')" \
  --body "Closes #${PROPOSAL_ID}.

Proposal: ${PROPOSAL_TEXT}

Passed constitution gate, then implemented by the agent at $(date -u +%Y-%m-%dT%H:%M:%SZ).
The \"Closes\" reference marks the proposal issue implemented when this merges;
if this PR closes without merging, the proposal becomes eligible again."); then
  echo "PR: $PR_URL"
  if gh pr merge --auto --squash "$PR_URL"; then
    echo "Auto-merge enabled — will squash-merge when the test check passes."
  else
    echo "::warning::Could not enable auto-merge on $PR_URL (requires branch protection on main + repo auto-merge setting). Merge manually."
  fi
else
  echo "::error::gh pr create failed. Check that secrets APP_ID / APP_PRIVATE_KEY are set and the GitHub App is installed on this repo with Contents + Pull requests write access."
  exit 1
fi

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) deliver done ==="
