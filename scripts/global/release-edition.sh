#!/usr/bin/env bash
# Checks a finished edition (check-edition.mjs) against the previous
# released one, then uploads it to the cycle's release (global-index-<cycle>).
# FORCE_RELEASE=true skips the check, after someone has reviewed the report.
# Usage: CYCLE=<cycle id> scripts/global/release-edition.sh   (from the repo root, with work/)
set -euo pipefail
TAG="global-index-$CYCLE"

# The newest earlier cycle that has an edition.
mkdir -p prev
for t in $(gh release list --limit 30 --json tagName -q '.[].tagName' | grep '^global-index-' | grep -vx "$TAG" || true); do
  if gh release download "$t" -p pcs-q-summary.json -D prev --clobber 2>/dev/null; then echo "Previous edition: $t"; break; fi
done
PREV=""
[ -f prev/pcs-q-summary.json ] && PREV="--previous prev/pcs-q-summary.json"
if ! node scripts/global/check-edition.mjs --work work $PREV --report edition-check.md; then
  if [ "${FORCE_RELEASE:-false}" = "true" ]; then echo "Edition check failed; releasing anyway (FORCE_RELEASE)"; else exit 1; fi
fi

mkdir -p out
cp work/pcs-q/pcs-q-*.json work/pcs-q/pcs-q-*.csv out/
# POSI Citation Ranking (PNCI-1.0 / CITATION-RANK-1.0): the official ranking edition.
cp work/citation-ranking/citation-ranking-*.json work/citation-ranking/citation-ranking-*.csv out/
cp work/citation-ranking/summary.json out/citation-ranking-summary.json
cp work/pcs-q/summary.json out/pcs-q-summary.json
[ -f work/pcs/summary.json ] && cp work/pcs/summary.json out/pcs-summary.json
cp work/cycle.json out/cycle.json
cp edition-check.md out/edition-check.md
tar -czf out/pcs-shards.tar.gz -C work/pcs pcs
gh release upload "$TAG" out/* --clobber
gh release edit "$TAG" --notes "GLOBAL-INDEX-1.0 cycle $CYCLE, posi-engine $(git rev-parse HEAD). Complete: journal corpus, Citation Ranking edition (PNCI-1.0) and the PCS edition.

$(cat edition-check.md)"
