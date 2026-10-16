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

import { parseBuildLogData } from '../src/utils/buildImageLog.ts';

test('parseBuildLogData distinguishes process lines from the final result', () => {
  assert.deepEqual(parseBuildLogData('{"line":"Step 1/3 : FROM alpine:3.20"}'), {
    kind: 'log',
    line: 'Step 1/3 : FROM alpine:3.20',
  });
  assert.deepEqual(
    parseBuildLogData('{"status":"failed","imageName":"app:1","message":"拉取基础镜像失败"}'),
    {
      kind: 'result',
      status: 'failed',
      imageName: 'app:1',
      message: '拉取基础镜像失败',
    },
  );
  assert.equal(parseBuildLogData('not-json'), null);
});
