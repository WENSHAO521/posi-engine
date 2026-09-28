#!/usr/bin/env bash
# Starts the next run of a workflow when this one stopped with work left
# (time budget reached), so a cycle finishes without anyone re-running it.
# The new run queues behind this one (the workflow's concurrency group) and
# resumes from the work directory this run saved to the actions cache.
#
# Usage: scripts/global/continue-run.sh <workflow file> "<what is unfinished>"
# Environment:
#   CONTINUATION       this run's number in the chain (0 for a first run)
#   MAX_CONTINUATIONS  cap on automatic runs in one chain (default 12)
#   PROGRESS           a measure of work done so far (e.g. journals with PCS)
#   PREV_PROGRESS      PROGRESS as the previous run in the chain left it
#   SAME_OK=true       continue even if PROGRESS did not change (stages whose
#                      progress this cannot see, e.g. a resumable harvest)
#   EXTRA_INPUTS       space-separated key=value inputs to pass on
# Stops, and opens an alert instead, at the cap or when a run made no
# progress, so a failing step can never loop.
set -euo pipefail
WORKFLOW="$1"; WHAT="$2"
N="${CONTINUATION:-0}"; MAX="${MAX_CONTINUATIONS:-12}"
[[ "$N" =~ ^[0-9]+$ ]] || N=0
DIR="$(dirname "$0")"

if [ "$N" -ge "$MAX" ]; then
  "$DIR/alert.sh" "$WHAT is unfinished after $N automatic continuation runs; stopped continuing. Run the workflow by hand within 7 days to resume from the cached progress."
  exit 0
fi
if [ "${SAME_OK:-false}" != "true" ] && [ -n "${PREV_PROGRESS:-}" ] && [ "${PROGRESS:-}" = "$PREV_PROGRESS" ]; then
  "$DIR/alert.sh" "$WHAT made no progress in this run (still $PROGRESS); stopped continuing automatically. Check the run log, then run the workflow by hand."
  exit 0
fi

ARGS=(-f "continuation=$((N + 1))" -f "prev_progress=${PROGRESS:-}")
for kv in ${EXTRA_INPUTS:-}; do ARGS+=(-f "$kv"); done
gh workflow run "$WORKFLOW" --ref "${GITHUB_REF_NAME:-master}" "${ARGS[@]}"
echo "$WHAT is unfinished (progress ${PROGRESS:-n/a}); started continuation run $((N + 1)) of at most $MAX"
