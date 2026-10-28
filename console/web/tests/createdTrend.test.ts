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

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

import {
  canUseCreatedDayBucket,
  collapseCreatedSeries,
  defaultCreatedBucket,
} from '../src/utils/createdTrend.ts';

dayjs.extend(utc);

test('month range defaults to daily buckets and a long range does not', () => {
  const month: [dayjs.Dayjs, dayjs.Dayjs] = [
    dayjs.utc('2026-10-01'),
    dayjs.utc('2026-10-31'),
  ];
  assert.equal(defaultCreatedBucket(month), 'day');
  assert.equal(canUseCreatedDayBucket(month), true);

  const quarter: [dayjs.Dayjs, dayjs.Dayjs] = [
    dayjs.utc('2026-10-01'),
    dayjs.utc('2026-12-31'),
  ];
  assert.equal(defaultCreatedBucket(quarter), 'month');
  assert.equal(canUseCreatedDayBucket(quarter), true);

  assert.equal(defaultCreatedBucket(null), 'month');
  assert.equal(canUseCreatedDayBucket(null), false);

  const allTime: [dayjs.Dayjs, dayjs.Dayjs] = [
    dayjs.utc('1970-01-01'),
    dayjs.utc('2026-10-19'),
  ];
  assert.equal(defaultCreatedBucket(allTime), 'month');
  assert.equal(canUseCreatedDayBucket(allTime), false);
});

test('more than eight tenants collapse to the top seven plus 其他', () => {
  const series = Array.from({ length: 9 }, (_, i) => ({
    tenant: `t${i}`,
    counts: [10 - i, i],
  }));
  const collapsed = collapseCreatedSeries(series);
  assert.deepEqual(
    collapsed.map((row) => row.tenant),
    ['t0', 't1', 't2', 't3', 't4', 't5', 't6', '其他'],
  );
  assert.deepEqual(collapsed[7].counts, [3 + 2, 7 + 8]);

  const eight = series.slice(0, 8);
  assert.equal(collapseCreatedSeries(eight).length, 8);
});
