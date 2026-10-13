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
  ./console/scripts/split-extended-pr-stack.sh branch e7 origin/main
EOF
}

# Commas separate commits; order matters (oldest first).
declare -A PR_COMMITS=(
  [e1]="6978e0f4,6a2440fe,6b33c25c,15711f34"
  [e2]="fce58f3f"
  [e3]="739496c3,164062c9,5e8eb375,87884f79"
  [e4]="752a35c6,869477c9,a559b56d"
  [e5]="752a35c6"
  [e6]="1aa6ce07"
  [e7]="095a7e84,5cb1527e"
  [e8]="19e2ed58"
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
    if [[ "$id" == "e2" || "$id" == "e5" || "$id" == "e6" ]]; then
      echo "      NOTE: mixed source commit — cherry-pick may require path-limited staging."
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
