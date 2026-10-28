#!/usr/bin/env bash
# Rebuild feat/console-extended-scope from main with mixed commits split (no git rebase -i).
# Source ref is only used to ensure the backup exists; SHAs are the pre-restack originals.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SOURCE_REF="${1:?usage: restack-extended-scope-commits.sh <source-ref>}"
TARGET_BRANCH="${2:-feat/console-extended-scope}"
BASE_REF="${3:-main}"

if ! git rev-parse --verify "$SOURCE_REF" >/dev/null 2>&1; then
  echo "Unknown source ref: $SOURCE_REF" >&2
  exit 1
fi

BACKUP="backup/console-extended-scope-before-restack-$(date +%Y%m%d%H%M%S)"
git branch "$BACKUP" "$TARGET_BRANCH"
echo "Backup: $BACKUP"

git checkout "$TARGET_BRANCH"
git reset --hard "$BASE_REF"

pick() {
  git cherry-pick "$1"
}

pick_split() {
  local sha="$1"
  shift
  git cherry-pick -n "$sha"
  git reset HEAD
  while [[ $# -ge 2 ]]; do
    local paths="$1"
    local msg="$2"
    shift 2
    # shellcheck disable=SC2086
    git add $paths
    if git diff --cached --quiet; then
      echo "Warning: empty stage for: $paths (from $sha)" >&2
    else
      git commit -m "$msg"
    fi
  done
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Leftover changes after split of $sha:" >&2
    git status -sb >&2
    exit 1
  fi
}

pick 11705fbe
pick 6503ba5e
pick 61419f7c
pick 6978e0f4
pick e9b1a470
pick 6a2440fe
pick 6b33c25c
pick 347b4b52

pick_split fce58f3f \
  "server/" "feat(server): PostgreSQL lifecycle audit writer and config" \
  "console/" "feat(console): align BFF history store with lifecycle audit table"

pick 739496c3
pick 9e6496fb
pick 164062c9

pick_split 752a35c6 \
  "console/ docs/guides/developer-console.md docs/superpowers/specs/2026-10-09-console-sandbox-shell-design.md" \
  "feat(console): WebSocket sandbox shell and terminal page" \
  "server/" "fix(server): surface BatchSandbox task failures in K8s provider"

pick 869477c9
pick a559b56d
pick 15711f34

pick_split 5e8eb375 \
  "console/bff/app/history/ console/bff/tests/test_history_poll.py console/docs/07-sandbox-history.md" \
  "feat(console): history poll reconcile for sandbox lifecycle state" \
  "console/" "feat(console): Grafana embed proxy and monitor nginx wiring"

pick_split 1aa6ce07 \
  "server/" "feat(server): lifecycle audit metadata columns and tests" \
  "console/" "feat(console): history labels, stats, and sandbox create UX"

pick 095a7e84
pick 5cb1527e
pick 19e2ed58
pick 1a042506
pick 87884f79
pick 82dbc739

echo "Restack complete on $TARGET_BRANCH (backup $BACKUP)."
git log --oneline "$BASE_REF"..HEAD
