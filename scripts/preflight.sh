#!/usr/bin/env bash
# Local/CI/agent gate: receive-only + build + tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

chmod +x "$ROOT"/scripts/locked/*.sh
"$ROOT/scripts/locked/check-receive-only.sh"

# Frozen files (constitution.md, scripts/locked/, workflows) must be
# untouched. CI runs the same check from the base ref, so it cannot be
# weakened here.
"$ROOT/scripts/locked/check-frozen.sh"

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
  "$ROOT/scripts/locked/smoke.sh"
else
  echo "warning: docker not reachable here — skipping smoke.sh (CI still runs it)"
fi
echo "OK: preflight passed"
