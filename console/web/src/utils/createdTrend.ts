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

import type { Dayjs } from 'dayjs';

export type CreatedBucket = 'day' | 'month';

/** Inclusive UTC days at or under this stay on daily buckets by default. */
export const CREATED_TREND_AUTO_DAY_MAX = 62;

/** Daily buckets are refused above this span. */
export const CREATED_TREND_DAY_MAX = 120;

/** Named stacks before the rest fold into 其他. Eight or fewer stay as-is. */
export const CREATED_TREND_NAMED_TENANTS = 7;

export interface CreatedSeriesRow {
  tenant: string;
  counts: number[];
}

export function inclusiveUtcDays(start: Dayjs, end: Dayjs): number {
  return end.utc().startOf('day').diff(start.utc().startOf('day'), 'day') + 1;
}

export function defaultCreatedBucket(range: [Dayjs, Dayjs] | null): CreatedBucket {
  if (!range) return 'month';
  return inclusiveUtcDays(range[0], range[1]) <= CREATED_TREND_AUTO_DAY_MAX ? 'day' : 'month';
}

export function canUseCreatedDayBucket(range: [Dayjs, Dayjs] | null): boolean {
  if (!range) return false;
  return inclusiveUtcDays(range[0], range[1]) <= CREATED_TREND_DAY_MAX;
}

function seriesTotal(row: CreatedSeriesRow): number {
  return row.counts.reduce((sum, count) => sum + count, 0);
}

export function collapseCreatedSeries(
  series: CreatedSeriesRow[],
  named = CREATED_TREND_NAMED_TENANTS,
): CreatedSeriesRow[] {
  const ranked = [...series].sort((a, b) => {
    const diff = seriesTotal(b) - seriesTotal(a);
    if (diff !== 0) return diff;
    return a.tenant.localeCompare(b.tenant);
  });
  if (ranked.length <= named + 1) return ranked;
  const head = ranked.slice(0, named);
  const rest = ranked.slice(named);
  const width = Math.max(0, ...ranked.map((row) => row.counts.length));
  const other = Array.from({ length: width }, (_, index) =>
    rest.reduce((sum, row) => sum + (row.counts[index] ?? 0), 0),
  );
  return [...head, { tenant: '其他', counts: other }];
}
