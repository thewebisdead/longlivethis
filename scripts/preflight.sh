#!/usr/bin/env bash
# Local/CI/agent gate: frozen check + build + tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

chmod +x "$ROOT"/scripts/locked/tests/*.sh

# Frozen files (constitution.md, scripts/locked/, workflows) must be
# untouched. CI runs the same check from the base ref, so it cannot be
# weakened here.
"$ROOT/scripts/locked/tests/check-frozen.sh"

# Scaffold placeholders must all have been substituted at init. A survivor is
# never harmless — `longlivethis` in app/package.json makes npm warn and
# carry on with a broken package name, and one in the Caddyfile produces a site
# served on a hostname nobody owns.
#
# Matches only real placeholder syntax — double braces around an UPPER_SNAKE
# key — so prose about braces does not trip it, and skips `${{ ... }}`, which is
# GitHub Actions expression syntax in the workflows, not a scaffold placeholder.
# scripts/locked/agent/ is excluded wholesale: its prompt .tmpl files and the
# render_template docs in lib.sh use the same syntax as a RUNTIME template
# language, and are meant to survive.
#
# Nothing in this file may spell a placeholder out literally: the grep scans the
# whole repo including itself, so an example in a comment here is indistinguish-
# able from a survivor and fails every fresh scaffold.
leftover=$(grep -rIn --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git \
             -E '(^|[^$])\{\{[A-Z_][A-Z0-9_]*\}\}' "$ROOT" 2>/dev/null \
           | grep -v '/scripts/locked/agent/' || true)
if [ -n "$leftover" ]; then
  echo "error: unsubstituted scaffold placeholders remain:" >&2
  echo "$leftover" >&2
  exit 1
fi

cd "$ROOT/app"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build

WALLET_ADDRESS="${WALLET_ADDRESS:-0x0000000000000000000000000000000000000000}" npm test

# Life-support smoke (frozen): boots the production image and checks the
# endpoints the app cannot live without. CI runs the same script — fix
# failures here rather than discovering them after the PR opens.
cd "$ROOT"
# Gate on docker being USABLE, not merely installed: the agent's implement step
# runs as an unprivileged sandbox user (no docker-group access) with the docker
# binary still on PATH, so `command -v docker` is true but the socket is denied.
# `docker info` needs a reachable daemon, so it skips cleanly there. The docker
# smoke still runs in CI (test.yml) and locally, where the daemon is reachable.
if docker info >/dev/null 2>&1; then
  "$ROOT/scripts/locked/tests/smoke.sh"
else
  echo "warning: docker not reachable here — skipping smoke.sh (CI still runs it)"
fi
echo "OK: preflight passed"
