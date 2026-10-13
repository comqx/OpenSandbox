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

import { buildMovedRelativePath, normalizeRelativePath } from './buildContextModel.ts';

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

/** Wrap flat root files under a single visible root (IDE-style context root). */
/** Unique directory paths implied by file paths (does not include build-context root). */
export type TreeDropHint = {
  dropKey: string;
  dropToGap: boolean;
  dropPosition: number;
};

/** Map a tree drag/drop gesture to a new file path (build-context relative). */
export function resolveTreeDropMove(fromPath: string, hint: TreeDropHint): string | null {
  const { dropKey, dropToGap } = hint;
  if (dropKey.startsWith('dir:')) {
    return buildMovedRelativePath(fromPath, dropKey);
  }
  if (dropToGap) {
    const fileName = fromPath.split('/').pop() ?? '';
    if (!fileName) {
      return null;
    }
    const parent = dropKey.includes('/') ? dropKey.slice(0, dropKey.lastIndexOf('/')) : '';
    return normalizeRelativePath(parent ? `${parent}/${fileName}` : fileName);
  }
  return null;
}

export function listBuildContextDirectoryKeys(paths: string[]): string[] {
  const dirs = listBuildContextDirectories(paths);
  return ['dir:__context_root__', ...dirs.map((dir) => `dir:${dir}`)];
}

export function listBuildContextDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join('/'));
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

export function wrapBuildContextTreeRoot(nodes: DataNode[]): DataNode[] {
  if (nodes.length === 0) {
    return [];
  }
  return [
    {
      key: 'dir:__context_root__',
      title: 'build-context',
      selectable: false,
      children: nodes,
    },
  ];
}
