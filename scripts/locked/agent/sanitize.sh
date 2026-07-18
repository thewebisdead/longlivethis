#!/usr/bin/env bash
# FROZEN at init — step 2: sanitize the selected proposal's text.
#
# The proposal body is user-supplied and untrusted. This step produces the
# single cleaned copy every later step reads (implementation prompt, branch
# slug, PR title/body) via the shared sanitize_text helper (see lib.sh for what
# it strips/neutralizes/caps). select-proposal.sh already sanitizes each
# candidate before the constitution gate, so proposal_text is normally clean
# already; sanitize_text is idempotent, so this re-clean is a safe no-op that
# keeps the pipeline stage independent.
set -euo pipefail

. "$(dirname "$0")/lib.sh"

RAW="$(state_get proposal_text)"
[ -n "$RAW" ] || { echo "sanitize: no proposal in state — nothing to do" >&2; exit 1; }

CLEAN="$(sanitize_text "$RAW")"

printf '%s' "$CLEAN" | state_put proposal_sanitized
echo "Sanitized proposal ($(printf '%s' "$CLEAN" | wc -c | tr -d ' ') bytes)."
