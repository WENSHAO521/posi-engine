#!/usr/bin/env bash
# Opens (or adds to) one issue on this repository when a global index run
# needs attention, so GitHub notifies the maintainers by email.
# Usage: scripts/global/alert.sh "<what happened>"   (ALERT_TITLE overrides the issue title)
set -uo pipefail
TITLE="${ALERT_TITLE:-Global index: run needs attention}"
URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
BODY="$1

Run: $URL (job: $GITHUB_JOB)"
[ -f edition-check.md ] && BODY="$BODY

$(cat edition-check.md)"
NUM=$(gh issue list --state open --search "\"$TITLE\" in:title" --json number -q '.[0].number' 2>/dev/null)
if [ -n "$NUM" ]; then gh issue comment "$NUM" --body "$BODY"; else gh issue create --title "$TITLE" --body "$BODY"; fi
