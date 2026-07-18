#!/usr/bin/env bash
# FROZEN at init — the app's life-support contract.
#
# Boots the production Docker image (same image the VPS runs) and verifies the
# two things the living app cannot survive without: the homepage loads and
# proposal intake works (GET/POST /api/proposals).
# If either breaks, the change must not merge — a dead proposal API means
# users can never submit work for the agent again.
#
# Proposals live in GitHub Issues; the app talks to $GITHUB_API_BASE, so this
# script runs a tiny stub GitHub API and points the app at it — no real issues
# are created and no token is needed. Runs in CI (test.yml, frozen) and in the
# agent's preflight. Like the constitution and workflows, this file is frozen:
# CI (check-frozen.sh) rejects any PR that modifies it.
# Assumes Linux/CI docker (host networking).
set -euo pipefail
cd "$(dirname "$0")/../.."

command -v docker >/dev/null 2>&1 || { echo "error: smoke.sh requires docker" >&2; exit 1; }

PORT="${SMOKE_PORT:-3100}"
STUB_PORT="${SMOKE_STUB_PORT:-3200}"
BASE="http://localhost:${PORT}"
NAME=longlive-smoke
BODY=$(mktemp)
STUB_JS=$(mktemp --suffix=.cjs 2>/dev/null || mktemp)
STUB_PID=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  rm -f "$BODY" "$STUB_JS"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true

# --- Stub GitHub API: GET /user, GET/POST /repos/*/*/issues, in-memory ------
cat > "$STUB_JS" <<'STUB'
const http = require('http')
const issues = []
let nextNumber = 1
http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const path = req.url.split('?')[0]
      if (req.method === 'GET' && path === '/user') return send(200, { login: 'stub-app' })
      if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
        if (req.method === 'GET') return send(200, issues)
        if (req.method === 'POST') {
          let b = {}
          try { b = JSON.parse(body || '{}') } catch {}
          const n = nextNumber++
          const issue = {
            number: n,
            title: String(b.title || ''),
            body: String(b.body || ''),
            state: 'open',
            html_url: `http://localhost:${process.env.STUB_PORT}/stub/issues/${n}`,
            created_at: new Date().toISOString(),
            reactions: { '+1': 0, '-1': 0 },
          }
          issues.push(issue)
          return send(201, issue)
        }
      }
      send(404, { message: 'stub: not found' })
    })
  })
  .listen(Number(process.env.STUB_PORT), () => console.log('stub github api up'))
STUB

STUB_PORT="$STUB_PORT" node "$STUB_JS" &
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
  "$NAME" >/dev/null

echo "smoke: waiting for the app…"
up=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE/api/proposals"; then
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

check 200 GET /
check 200 GET /api/proposals
check 201 POST /api/proposals '{"text":"smoke: life-support check"}'

# Proposal intake round-trip: the POSTed proposal must appear in the feed
# (JSON array + cache invalidation both work).
if ! curl -sf "$BASE/api/proposals" | node -e '
  let d = ""
  process.stdin.on("data", (c) => (d += c))
  process.stdin.on("end", () => {
    const rows = JSON.parse(d)
    if (!Array.isArray(rows)) process.exit(1)
    if (!rows.some((r) => r.text === "smoke: life-support check")) process.exit(1)
  })
'; then
  echo "FAIL GET /api/proposals: not a JSON array containing the posted proposal" >&2
  fail=1
fi

if [ "$fail" != 0 ]; then
  echo "error: life-support smoke failed — this change would kill the app" >&2
  exit 1
fi
echo "OK: smoke passed (production image serves the life-support endpoints)"
