#!/usr/bin/env bash
# Copyright 2026 The OpenSandbox Authors
#
# Solo fork sync: update base (main) from upstream, rebase custom onto it.
# Run from repo root. Stops on conflicts during rebase for manual resolution.
#
# Remotes: upstream = opensandbox-group (read-only), origin = your fork.
# Branches: main (or base) = pure upstream; custom = all local patches (rebase only).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_BRANCH="${BASE_BRANCH:-main}"
CUSTOM_BRANCH="${CUSTOM_BRANCH:-custom}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--fetch-only | --update-base-only]

  (no args)     fetch upstream, fast-forward ${BASE_BRANCH}, rebase ${CUSTOM_BRANCH}, remind to test/push
  --fetch-only  git fetch upstream only
  --update-base-only  fetch + merge ${UPSTREAM_REF} into ${BASE_BRANCH} and push origin ${BASE_BRANCH}
EOF
}

fetch_upstream() {
  git fetch upstream
}

update_base() {
  git checkout "${BASE_BRANCH}"
  git merge --ff-only "${UPSTREAM_REF}"
  git push origin "${BASE_BRANCH}"
  if git show-ref --verify --quiet "refs/heads/base"; then
    git branch -f base "${BASE_BRANCH}"
    git push origin base
  fi
}

rebase_custom() {
  git checkout "${CUSTOM_BRANCH}"
  if ! git rebase "${BASE_BRANCH}"; then
    cat <<EOF >&2

Rebase stopped with conflicts.
  Fix files, then: git add <files> && git rebase --continue
  Abort sync:       git rebase --abort

After rebase succeeds, run tests, then:
  git push --force-with-lease origin ${CUSTOM_BRANCH}
EOF
    exit 1
  fi
  cat <<EOF

Rebase finished on ${CUSTOM_BRANCH}.
Run your test suite, then push:
  git push --force-with-lease origin ${CUSTOM_BRANCH}
EOF
}

case "${1:-}" in
  --fetch-only)
    fetch_upstream
    ;;
  --update-base-only)
    fetch_upstream
    update_base
    ;;
  -h | --help)
    usage
    ;;
  "")
    fetch_upstream
    update_base
    rebase_custom
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
