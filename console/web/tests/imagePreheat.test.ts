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

import { mergePreheatProgress } from '../src/utils/imagePreheat.ts';

test('finished nodes stay after the server deletes their pods', () => {
  const previous = [
    { nodeName: 'node-a', podName: 'preheat-a', state: 'succeeded' as const, message: '' },
    { nodeName: 'node-b', podName: 'preheat-b', state: 'pulling' as const, message: '' },
  ];
  const incoming = [
    { nodeName: 'node-b', podName: 'preheat-b', state: 'failed' as const, message: 'denied' },
  ];
  assert.deepEqual(mergePreheatProgress(previous, incoming), [
    { nodeName: 'node-a', podName: 'preheat-a', state: 'succeeded', message: '' },
    { nodeName: 'node-b', podName: 'preheat-b', state: 'failed', message: 'denied' },
  ]);
});
