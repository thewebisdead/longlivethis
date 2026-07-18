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

# Reverse proxy (Caddy: TLS + rate limits). Caddyfile is rendered at scaffold time.
if [ -f Caddyfile ]; then
  cp Caddyfile /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

# Build + (re)start the app. No database — proposals live in GitHub Issues.
docker compose up -d --build

echo "deploy: done"
