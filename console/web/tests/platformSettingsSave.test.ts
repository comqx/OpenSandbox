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

import { platformSettingsSavePayload } from '../src/utils/platformSettingsSave.ts';

test('save keeps recommendation fields that are not mounted on the active tab', () => {
  const payload = platformSettingsSavePayload(
    { baseUrl: 'https://grafana.example', dashboardUid: 'abc' },
    {
      baseUrl: 'https://grafana.example',
      persisted: true,
      source: 'db',
      resourceRecommendation: {
        enabled: true,
        prometheusUrl: 'http://prom.example',
        cpuLimitRatio: 1.2,
        memoryLimitRatio: 1.15,
        cpuPromql: 'sum by (pod) (rate(cpu[2m]))',
        schemaVersion: 1,
      },
    },
  );

  assert.equal(payload.resourceRecommendation?.cpuLimitRatio, 1.2);
  assert.equal(payload.resourceRecommendation?.memoryLimitRatio, 1.15);
  assert.equal(payload.resourceRecommendation?.prometheusUrl, 'http://prom.example');
  assert.equal(payload.resourceRecommendation?.schemaVersion, undefined);
  assert.equal(payload.persisted, undefined);
  assert.equal(payload.source, undefined);
  assert.equal(payload.baseUrl, 'https://grafana.example');
});

test('edited recommendation fields override the stored copy', () => {
  const payload = platformSettingsSavePayload(
    {
      resourceRecommendation: {
        cpuLimitRatio: 1.4,
        cpuPromql: 'custom',
      },
    },
    {
      resourceRecommendation: {
        cpuLimitRatio: 1.2,
        memoryLimitRatio: 1.15,
        cpuPromql: 'default',
        schemaVersion: 1,
      },
    },
  );

  assert.equal(payload.resourceRecommendation?.cpuLimitRatio, 1.4);
  assert.equal(payload.resourceRecommendation?.memoryLimitRatio, 1.15);
  assert.equal(payload.resourceRecommendation?.cpuPromql, 'custom');
  assert.equal(payload.resourceRecommendation?.schemaVersion, undefined);
});
