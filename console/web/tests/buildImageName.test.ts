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
  BUILD_IMAGE_PREFIX,
  buildImageNameError,
  composeBuildImageName,
  imageSuffixFromInput,
} from '../src/utils/buildImageName.ts';

test('composeBuildImageName keeps the registry prefix and accepts a suffix', () => {
  assert.equal(composeBuildImageName('app:1.0'), `${BUILD_IMAGE_PREFIX}app:1.0`);
  assert.equal(composeBuildImageName(' team/app:1.0 '), `${BUILD_IMAGE_PREFIX}team/app:1.0`);
  assert.equal(
    composeBuildImageName(`${BUILD_IMAGE_PREFIX}app:1.0`),
    `${BUILD_IMAGE_PREFIX}app:1.0`,
  );
  assert.equal(imageSuffixFromInput(`${BUILD_IMAGE_PREFIX}/app:1.0`), 'app:1.0');
  assert.equal(buildImageNameError(''), '镜像名称不能为空');
  assert.equal(buildImageNameError('../evil:1'), '镜像名称不合法');
  assert.equal(buildImageNameError('app:1.0'), null);
});
