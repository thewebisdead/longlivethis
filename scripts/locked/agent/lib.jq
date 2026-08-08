# FROZEN — shared jq defs for the split agent loop. Prepended (via $JQ_LIB in
# lib.sh) onto every jq -c/-n program that needs them, so a definition lives in
# one place.
#
# claim_re($id) — matches a PR body whose opening line claims issue #N.
#   deliver.sh writes "Closes #<issue>" as the FIRST body line of every PR it
#   opens; this regex matches that opening claim (case-insensitive, anchored,
#   word-boundary after the number) so a bare "#N" elsewhere — e.g. inside
#   quoted proposal text — cannot freeze the queue.
#
# net_votes — 👍 ("+1") minus 👎 ("-1"); other emojis ignored; missing fields
#   default to 0. Same rule as app/src/lib/github.ts mapIssue — keep in
#   lockstep.
def claim_re($id): "(?i)^\\s*closes #\($id)\\b";
def net_votes: (.reactions["+1"] // 0) - (.reactions["-1"] // 0);
