#!/usr/bin/env bash
# FROZEN at init — brings a BARE x402Compute VPS up to a deployable state, then
# runs the normal deploy. THE single box-bootstrap: create-longlive's deploy step
# uploads and runs this file at init, and migrate-vps.mjs runs it again when the
# balance rule moves the app to a new box — so a freshly provisioned box and a
# migrated box are identical by construction, not by keeping two copies in sync.
# Idempotent: safe to re-run on a half-provisioned box.
#
# Precondition: /etc/longlive/app.env already uploaded (receive-only app config —
# no spend keys). REPO_URL passed as $1 or the REPO_URL env var.
set -euo pipefail

REPO_URL="${1:-${REPO_URL:-}}"
[ -n "$REPO_URL" ] || { echo "bootstrap: REPO_URL is required (arg 1 or env)"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

echo "bootstrap: base packages…"
apt-get update -qq
apt-get install -y -qq curl git gnupg2 ca-certificates apt-transport-https

echo "bootstrap: docker…"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker || true

# Stock caddy is sufficient — rate limiting lives at the Cloudflare edge
# (set up at init via the Rulesets API), and Authenticated Origin Pulls use
# stock TLS client_auth (built into caddy).
echo "bootstrap: caddy…"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi

# Cloudflare Authenticated Origin Pull CA cert. Verified by Caddy's
# `tls { client_auth { mode require_and_verify ... } }` block when the
# deployment is CF-fronted — forces every origin connection to come from
# Cloudflare, so bypassing the edge (and its rate limit) fails TLS. Idempotent;
# harmless on direct (non-CF) deployments that just won't reference it.
mkdir -p /etc/caddy
curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
  -o /etc/caddy/cloudflare-origin.pem

systemctl enable caddy 2>/dev/null || true

echo "bootstrap: firewall 80/443…"
command -v ufw >/dev/null 2>&1 && ufw allow 80/tcp && ufw allow 443/tcp || true

echo "bootstrap: clone / update repo…"
mkdir -p /opt/longlive /etc/longlive
i=1; while :; do
  { if [ -d /opt/longlive/.git ]; then
      cd /opt/longlive && git remote set-url origin "$REPO_URL" && git fetch origin && git reset --hard origin/main
    else
      rm -rf /opt/longlive && git clone "$REPO_URL" /opt/longlive
    fi; } && break
  [ $i -ge 6 ] && { echo "bootstrap: git failed after $i attempts"; exit 1; }
  echo "bootstrap: git attempt $i failed; retrying in 5s…"; i=$((i+1)); sleep 5
done

echo "bootstrap: deploy…"
cd /opt/longlive && bash scripts/deploy.sh
echo "bootstrap: done"
