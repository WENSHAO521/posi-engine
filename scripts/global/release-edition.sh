#!/usr/bin/env bash
# Uploads a finished PCS-Q edition to the cycle's release (global-index-<cycle>).
# Usage: CYCLE=<cycle id> scripts/global/release-edition.sh   (from the repo root, with work/)
set -euo pipefail
TAG="global-index-$CYCLE"
mkdir -p out
cp work/pcs-q/pcs-q-*.json work/pcs-q/pcs-q-*.csv out/
cp work/pcs-q/summary.json out/pcs-q-summary.json
[ -f work/pcs/summary.json ] && cp work/pcs/summary.json out/pcs-summary.json
cp work/cycle.json out/cycle.json
tar -czf out/pcs-shards.tar.gz -C work/pcs pcs
gh release upload "$TAG" out/* --clobber
gh release edit "$TAG" --notes "GLOBAL-INDEX-1.0 cycle $CYCLE, posi-engine $(git rev-parse HEAD). Complete: journal corpus and PCS-Q edition."
