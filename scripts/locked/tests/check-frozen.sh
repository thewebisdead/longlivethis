#!/usr/bin/env bash
# FROZEN at init — single implementation of the freeze check.
#
# Verifies against a base ref (default origin/main) that:
#   1. constitution.md and everything in scripts/locked/ is unchanged as a
#      whole — no edits, deletions, or additions,
#   2. .github/workflows/ is unchanged (holds spend/SSH credentials).
#
# Content-only comparison: mode (chmod +x) drift from CI/agent must not trip
# the freeze. Called by scripts/preflight.sh locally; CI (test.yml) runs the
# BASE REF's copy of this script so a tampered working-tree copy cannot lie.
# Skips silently when the base ref does not exist (fresh clone without remote).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
BASE="${1:-origin/main}"

if ! git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then
  echo "check-frozen: base ref $BASE not found — skipping (CI still enforces the freeze)"
  exit 0
fi

status=0

# Compare one path's CONTENT between the base ref and the working tree. A
# missing side hashes to the empty string, so this one comparison covers all
# three verdicts: edited (both present, blobs differ), deleted (base only), and
# added (working tree only).
check_one() {
  local f="$1" base_blob wt_blob
  # --verify -q, not a bare rev-parse: given a path the ref does not contain,
  # bare `git rev-parse` ECHOES its argument to stdout ("main:scripts/x") rather
  # than returning nothing, so base_blob would hold a garbage string instead of
  # "". Additions were still caught — garbage never equals a real hash — but by
  # accident rather than by the empty-vs-hash rule this function documents.
  base_blob="$(git rev-parse --verify -q "$BASE:$f" 2>/dev/null || true)"
  wt_blob=""
  [ -f "$f" ] && wt_blob="$(git hash-object "$f")"
  [ "$base_blob" = "$wt_blob" ] && return 0
  echo "error: $f is frozen and cannot be changed, added, or removed (vs $BASE)" >&2
  git diff "$BASE" -- "$f" || true
  status=1
}

# The frozen set is enumerated from BOTH sides, in two passes, because neither
# side alone sees everything: the base ref cannot know about a file the branch
# ADDED, and the working tree cannot know about a file the branch DELETED. A
# plain `git diff` would miss additions that are untracked at the time of a
# local preflight run.
#
# Paths are carried NUL-delimited (-z / -print0) rather than newline-delimited,
# because newline-delimiting mangles two kinds of path:
#   - non-ASCII: `git ls-tree --name-only` C-quotes them
#     ("scripts/locked/caf\303\251.sh"), and the quoted form matches nothing on
#     disk, so an UNCHANGED file is reported as frozen-and-modified. Verified:
#     the pre-NUL version failed on a repo that merely contained one.
#   - embedded newline: the path splits into fragments naming nothing. This
#     still failed the check rather than passing it, but it named a path
#     fragment that does not exist, which is a misleading report rather than an
#     accurate one.
# Neither is likely in this repo; both are cheap to make impossible.

# Pass 1 — everything frozen in the base ref. Catches edits and deletions.
while IFS= read -r -d '' f; do
  check_one "$f"
done < <( { git ls-tree -r -z --name-only "$BASE" -- scripts/locked; \
            printf 'constitution.md\0'; } )

# Pass 2 — files on disk that the base ref does not have. Catches additions.
# Files present in both were already handled by pass 1, so they are skipped
# here rather than reported twice.
while IFS= read -r -d '' f; do
  git rev-parse --verify -q "$BASE:$f" >/dev/null 2>&1 || check_one "$f"
done < <(find scripts/locked -type f -print0 2>/dev/null)

if ! git diff --quiet "$BASE" -- .github/workflows 2>/dev/null; then
  echo "error: .github/workflows/ is frozen (holds spend/SSH credentials)." >&2
  echo "       To change how the app deploys, edit scripts/deploy.sh instead." >&2
  git diff "$BASE" -- .github/workflows || true
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: frozen files unchanged (constitution.md, scripts/locked/, .github/workflows/)"
fi
exit "$status"
