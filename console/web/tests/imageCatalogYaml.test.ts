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
  imageCatalogYamlTemplate,
  parseImageCatalogYaml,
} from '../src/utils/imageCatalogYaml.ts';

test('template keeps the field keys and comments', () => {
  const text = imageCatalogYamlTemplate({ maintainer: 'platform' });
  assert.match(text, /^# 名称/m);
  assert.match(text, /^displayName: ""$/m);
  assert.match(text, /^imageUri: ""$/m);
  assert.match(text, /^scenarios:$/m);
  assert.match(text, /^systemPackages:$/m);
  assert.match(text, /^runtimePackages:$/m);
  assert.match(text, /^maintainer: "platform"$/m);
});

test('filled values round-trip through the commented template', () => {
  const text = imageCatalogYamlTemplate({
    displayName: 'agentscope镜像',
    imageUri: 'hub.example.com/agentscope:1',
    scenarios: ['数据分析', 'Agent 工具调用'],
    systemPackages: ['git', 'curl'],
    runtimePackages: ['Python 3.12'],
    maintainer: 'platform',
  });
  assert.deepEqual(parseImageCatalogYaml(text), {
    displayName: 'agentscope镜像',
    imageUri: 'hub.example.com/agentscope:1',
    scenarios: ['数据分析', 'Agent 工具调用'],
    systemPackages: ['git', 'curl'],
    runtimePackages: ['Python 3.12'],
    maintainer: 'platform',
  });
});

test('blank template values are rejected and comments are ignored', () => {
  assert.throws(() => parseImageCatalogYaml(imageCatalogYamlTemplate()), /displayName/);
  const edited = imageCatalogYamlTemplate({ maintainer: 'platform' }).replace(
    'displayName: ""',
    'displayName: Python',
  ).replace('imageUri: ""', 'imageUri: python:3.12');
  const parsed = parseImageCatalogYaml(edited);
  assert.equal(parsed.displayName, 'Python');
  assert.equal(parsed.imageUri, 'python:3.12');
  assert.deepEqual(parsed.scenarios, []);
});
