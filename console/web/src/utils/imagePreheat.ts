// Copyright 2026 The OpenSandbox Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { PreheatNodeStatus } from '../api/types';

export function mergePreheatProgress(
  previous: PreheatNodeStatus[],
  incoming: PreheatNodeStatus[],
): PreheatNodeStatus[] {
  const incomingByNode = new Map(incoming.map((node) => [node.nodeName, node]));
  const seen = new Set<string>();
  const merged = previous.map((node) => {
    seen.add(node.nodeName);
    if (node.state === 'succeeded' || node.state === 'failed') return node;
    return incomingByNode.get(node.nodeName) ?? node;
  });
  for (const node of incoming) {
    if (!seen.has(node.nodeName)) merged.push(node);
  }
  return merged;
}

export function preheatFinished(nodes: PreheatNodeStatus[]): boolean {
  return nodes.length > 0 && nodes.every((node) => node.state === 'succeeded' || node.state === 'failed');
}
