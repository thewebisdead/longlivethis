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
while IFS= read -r f; do
  [ -z "$f" ] && continue
  base_blob="$(git rev-parse "$BASE:$f" 2>/dev/null || true)"
  wt_blob=""
  [ -f "$f" ] && wt_blob="$(git hash-object "$f")"
  if [ "$base_blob" != "$wt_blob" ]; then
    echo "error: $f is frozen and cannot be changed, added, or removed (vs $BASE)" >&2
    git diff "$BASE" -- "$f" || true
    status=1
  fi
done < <( { git ls-tree -r --name-only "$BASE" -- scripts/locked; \
            find scripts/locked -type f 2>/dev/null; \
            echo constitution.md; } | sort -u )

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
