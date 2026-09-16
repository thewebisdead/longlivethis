#!/usr/bin/env bash
# Deploy procedure — runs ON the VPS. AGENT-OWNED: you may change these steps as
# features require (run migrations, add a service, change the build). There are no
# spend keys on the VPS, so the blast radius is this box only.
#
# The workflow that invokes this — .github/workflows/deploy.yml — is FROZEN and holds
# the SSH credentials. Do not try to edit workflows; change deployment here instead.
#
# Invoked as `bash scripts/deploy.sh` from the repo root after `git pull` (deploy.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

# Snapshot cache directory — Caddy serves prerendered HTML from here, the app
# writes it via /api/snapshot. Shared between Caddy (host) and the app container
# via a bind mount. Owned by the host user Caddy runs as.
mkdir -p /var/lib/caddy/snapshots

# Reverse proxy (Caddy: TLS). Caddyfile is rendered at scaffold time.
if [ -f Caddyfile ]; then
  cp Caddyfile /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

# Build + (re)start the app. No database — proposals live in GitHub Issues.
docker compose up -d --build

# Seed the snapshot after the app is up. This is best-effort — the app will
# regenerate it on first non-cached request — but seeding it here means Caddy
# can serve the cached copy immediately rather than proxying the first visitor.
echo "deploy: seeding snapshot…"
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/api/snapshot 2>/dev/null; then
    echo "deploy: snapshot seeded"
    break
  fi
  sleep 2
done

echo "deploy: done"
