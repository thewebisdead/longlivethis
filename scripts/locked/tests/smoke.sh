#!/usr/bin/env bash
# FROZEN at init — the app's life-support contract.
#
# Boots the production Docker image (same image the VPS runs) and verifies the
# one thing the living app cannot survive without: proposal intake works
# (POST /api/proposals returns 201).
# If that breaks, the change must not merge — a dead proposal API means users
# can never submit work for the agent again.
#
# Proposals live in GitHub Issues; the app talks to $GITHUB_API_BASE, so this
# script runs a tiny stub GitHub API (github-stub.mjs, alongside this file) and
# points the app at it — no real issues are created and no token is needed.
# Runs in CI (test.yml, frozen) and in the agent's preflight. Like the
# constitution and workflows, this file is frozen: CI (check-frozen.sh) rejects
# any PR that modifies it.
# Assumes Linux/CI docker (host networking).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../.."

command -v docker >/dev/null 2>&1 || { echo "error: smoke.sh requires docker" >&2; exit 1; }

PORT="${SMOKE_PORT:-3100}"
STUB_PORT="${SMOKE_STUB_PORT:-3200}"
BASE="http://localhost:${PORT}"
NAME=longlive-smoke
BODY=$(mktemp)
STUB_PID=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  rm -f "$BODY"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

# --- Stub GitHub API: GET /user, GET/POST /repos/*/*/issues, in-memory ------
STUB_PORT="$STUB_PORT" node "$HERE/github-stub.mjs" &
STUB_PID=$!

echo "smoke: building production image…"
docker build -t "$NAME" app

# Host networking so the container reaches the stub on localhost.
echo "smoke: starting container on :${PORT}…"
docker run -d --name "$NAME" --network host \
  -e PORT="$PORT" \
  -e GITHUB_API_BASE="http://localhost:${STUB_PORT}" \
  -e GITHUB_REPO="stub/repo" \
  -e GITHUB_TOKEN="stub-token" \
  -e WALLET_ADDRESS="${WALLET_ADDRESS:-0x0000000000000000000000000000000000000000}" \
  -e PUBLIC_URL="$BASE" \
  -e GITHUB_OAUTH_BASE="http://localhost:${STUB_PORT}" \
  -e GITHUB_OAUTH_CLIENT_ID="stub-client-id" \
  -e GITHUB_OAUTH_CLIENT_SECRET="stub-client-secret" \
  -e VOTE_SIGNING_SECRET="stub-signing-secret" \
  "$NAME" >/dev/null

echo "smoke: waiting for the app…"
up=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE/"; then
    up=1
    break
  fi
  sleep 2
done
if [ "$up" != 1 ]; then
  echo "error: app did not come up on :${PORT}" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi

fail=0
check() { # check <want-status> <method> <path> [json-body]
  local want="$1" method="$2" path="$3" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE$path")
  if [ -n "$data" ]; then
    args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  local got
  got=$(curl "${args[@]}" || echo 000)
  if [ "$got" = "$want" ]; then
    echo "ok   $method $path → $got"
  else
    echo "FAIL $method $path → $got (want $want)"
    head -c 300 "$BODY" >&2 || true
    echo >&2
    fail=1
  fi
}

# Follow the whole vote redirect chain (app → GitHub consent → app callback →
# feed) and assert where it lands. The outcome rides back as ?vote=..., so the
# final URL is the assertion.
vote_flow() { # vote_flow <want-outcome> <path>
  local want="$1" path="$2" landed
  landed=$(curl -s -L -o "$BODY" -w '%{url_effective}' "$BASE$path" || echo '')
  case "$landed" in
    *"vote=$want"*)
      echo "ok   GET $path → vote=$want"
      ;;
    *)
      echo "FAIL GET $path → landed on '$landed' (want vote=$want)"
      fail=1
      ;;
  esac
}

check 201 POST /api/proposals '{"text":"smoke: life-support check"}'

# Voting is how proposals get chosen, so a broken vote path starves the agent
# just as surely as a broken intake. Issue 1 is the proposal created above.
vote_flow ok '/api/vote?issue=1&dir=up'
# Changing your mind must land on −1, not net zero: casting the opposite has to
# clear the first reaction, or the count silently misrepresents the vote.
vote_flow ok '/api/vote?issue=1&dir=down'

# A `state` blob that was not signed by this app must never cast a vote — that
# signature is the only thing standing between a link and a forged vote.
vote_flow failed '/api/vote/callback?code=stub-oauth-code&state=forged.blob'

if [ "$fail" != 0 ]; then
  echo "error: life-support smoke failed — this change would kill the app" >&2
  exit 1
fi
echo "OK: smoke passed (proposal intake + voting)"
