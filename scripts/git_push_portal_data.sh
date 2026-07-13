#!/usr/bin/env bash
# Reliable push for auto-generated data/*.json (avoids rebase conflicts).
set -euo pipefail

MESSAGE="${1:-chore: update portal data}"
MAX_ATTEMPTS="${2:-5}"
PRE_EXPORT_CMD="${3:-}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== Git push attempt ${attempt}/${MAX_ATTEMPTS} ==="
  git fetch origin main
  git reset --hard origin/main

  if [ -n "$PRE_EXPORT_CMD" ]; then
    eval "$PRE_EXPORT_CMD"
  fi

  git add data/manifest.json data/shm137.json data/evka.json data/probes/ data/overrides.json 2>/dev/null || \
    git add data/

  if git diff --staged --quiet; then
    echo "No data changes to commit"
    exit 0
  fi

  git commit -m "$MESSAGE"

  if git push origin HEAD:main; then
    echo "Push succeeded"
    exit 0
  fi

  echo "Push rejected (race with another workflow), retrying..."
done

echo "::error::Failed to push portal data after ${MAX_ATTEMPTS} attempts"
exit 1
