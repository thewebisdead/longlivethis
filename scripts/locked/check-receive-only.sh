#!/usr/bin/env bash
# Fail if app/ contains spend-secret patterns (mirrors CI).
# constitution.md may name WALLET_PRIVATE_KEY only to forbid it — excluded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if grep -RInE 'WALLET_PRIVATE_KEY|INFERENCE_API_KEY|BEGIN (OPENSSH |RSA )?PRIVATE KEY' app/ \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
  --exclude=constitution.md 2>/dev/null; then
  echo "error: app/ must remain receive-only (no private keys or inference API keys)" >&2
  exit 1
fi
echo "OK: receive-only (no spend-secret patterns in app/)"
