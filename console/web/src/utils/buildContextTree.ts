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

import type { DataNode } from 'antd/es/tree';

export function buildContextTreeData(paths: string[]): DataNode[] {
  const root: DataNode[] = [];
  const dirIndex = new Map<string, DataNode>();

  const sorted = [...paths].sort();
  for (const path of sorted) {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (!fileName) {
      continue;
    }
    let siblings = root;
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let dirNode = dirIndex.get(prefix);
      if (!dirNode) {
        dirNode = { key: `dir:${prefix}`, title: part, selectable: false, children: [] };
        dirIndex.set(prefix, dirNode);
        siblings.push(dirNode);
      }
      siblings = dirNode.children ?? [];
    }
    siblings.push({
      key: path,
      title: fileName,
      isLeaf: true,
    });
  }
  return root;
}
