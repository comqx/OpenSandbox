#!/usr/bin/env bash
# Copyright 2026 The OpenSandbox Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage:
  split-extended-pr-stack.sh list
      Print PR groups and commit SHAs (for manual cherry-pick).

  split-extended-pr-stack.sh branch <pr-id> <base-ref>
      Create a new branch from base-ref and cherry-pick the group's commits in order.
      pr-id: e1 | e2 | e3 | e4 | e5 | e6 | e7 | e8

Example:
  ./console/scripts/split-extended-pr-stack.sh branch e7 main
EOF
}

# Commas separate commits; order matters (oldest first).
# SHAs from custom (formerly feat/console-extended-scope) after restack. Re-run `list` after history rewrite.
declare -A PR_COMMITS=(
  [e1]="c0d40cbc,aecec41e,f53fcf8a,3f08fb7f,077d0f20,6ba7e9ba"
  [e2]="b40a7cfc,9350e07f"
  [e3]="477dbb94,cd56bed2,2c08ea33,c9dfacaf"
  [e4]="12a562ed,fbf9b66d,771e1e83"
  [e5]="0837dcc6"
  [e6]="0a7d8a0b"
  [e7]="7c31dba1,d59776ec"
  [e8]="e82ec68a"
)

declare -A PR_BRANCH=(
  [e1]="feat/console-ext-history"
  [e2]="feat/server-lifecycle-audit"
  [e3]="feat/console-ext-grafana-platform"
  [e4]="feat/console-sandbox-shell"
  [e5]="fix/server-k8s-batch-task-failure"
  [e6]="feat/console-history-labels-create"
  [e7]="feat/console-image-catalog"
  [e8]="feat/console-image-build-spec"
)

list_groups() {
  echo "Extended-scope PR groups (see console/docs/PR-STACK-extended-scope.md):"
  echo
  for id in e1 e2 e3 e4 e5 e6 e7 e8; do
    echo "  $id  branch: ${PR_BRANCH[$id]}"
    echo "      commits: ${PR_COMMITS[$id]}"
    if [[ "$id" == "e1" || "$id" == "e3" ]]; then
      echo "      NOTE: cherry-pick onto upstream MVP (E0), not raw main, unless E0 is merged."
    fi
    echo
  done
}

create_branch() {
  local pr_id="${1:?pr-id required}"
  local base_ref="${2:?base-ref required}"
  pr_id="${pr_id,,}"
  if [[ -z "${PR_COMMITS[$pr_id]+x}" ]]; then
    echo "Unknown pr-id: $pr_id" >&2
    usage
    exit 1
  fi
  local branch="${PR_BRANCH[$pr_id]}"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    echo "Branch already exists: $branch" >&2
    exit 1
  fi
  git checkout -b "$branch" "$base_ref"
  IFS=',' read -ra shas <<< "${PR_COMMITS[$pr_id]}"
  for sha in "${shas[@]}"; do
    echo "Cherry-picking $sha ..."
    if ! git cherry-pick "$sha"; then
      echo "Cherry-pick stopped at $sha. Fix conflicts, then: git cherry-pick --continue" >&2
      exit 1
    fi
  done
  echo "Created $branch from $base_ref with ${#shas[@]} commit(s)."
}

cmd="${1:-}"
case "$cmd" in
  list) list_groups ;;
  branch) create_branch "${2:-}" "${3:-}" ;;
  *) usage; exit 1 ;;
esac
