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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContextTreeData,
  listBuildContextDirectories,
  resolveTreeDropMove,
  wrapBuildContextTreeRoot,
} from '../src/utils/buildContextTree.ts';

test('buildContextTreeData nests paths under directories', () => {
  const tree = buildContextTreeData(['Dockerfile', 'certs/a.csr', 'certs/b.key']);
  assert.equal(tree.length, 2);
  const docker = tree.find((node) => node.key === 'Dockerfile');
  assert.ok(docker?.isLeaf);
  const certs = tree.find((node) => node.key === 'dir:certs');
  assert.ok(certs?.children?.length === 2);
});

test('resolveTreeDropMove treats folder gap drop as move into folder', () => {
  assert.equal(
    resolveTreeDropMove('abcd', { dropKey: 'dir:abcd2', dropToGap: true, dropPosition: 1 }),
    'abcd2/abcd',
  );
  assert.equal(
    resolveTreeDropMove('x.txt', { dropKey: 'dir:__context_root__', dropToGap: false, dropPosition: 0 }),
    'x.txt',
  );
});

test('listBuildContextDirectories collects parent paths', () => {
  assert.deepEqual(listBuildContextDirectories(['Dockerfile', 'certs/a.csr', 'certs/sub/b.key']), [
    'certs',
    'certs/sub',
  ]);
});

test('wrapBuildContextTreeRoot groups root-level files', () => {
  const wrapped = wrapBuildContextTreeRoot(buildContextTreeData(['Dockerfile', 'readme.txt']));
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0]?.key, 'dir:__context_root__');
  assert.equal(wrapped[0]?.children?.length, 2);
});
