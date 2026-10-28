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

import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

export function toIsoUtcStart(d: Dayjs): string {
  return d.utc().startOf('day').toISOString().replace('.000Z', 'Z');
}

export function toIsoUtcEndExclusive(d: Dayjs): string {
  return d.utc().add(1, 'day').startOf('day').toISOString().replace('.000Z', 'Z');
}

export function currentMonthRangeUtc(): [Dayjs, Dayjs] {
  const start = dayjs.utc().startOf('month');
  const end = dayjs.utc().endOf('month');
  return [start, end];
}

export function previousMonthRangeUtc(): [Dayjs, Dayjs] {
  const anchor = dayjs.utc().subtract(1, 'month');
  return [anchor.startOf('month'), anchor.endOf('month')];
}

/** Same as {@link currentMonthRangeUtc}; named for preset buttons. */
export function presetThisMonth(): [Dayjs, Dayjs] {
  return currentMonthRangeUtc();
}

export function presetLastMonth(): [Dayjs, Dayjs] {
  return previousMonthRangeUtc();
}

export function presetThisQuarter(): [Dayjs, Dayjs] {
  const now = dayjs.utc();
  const q = Math.floor(now.month() / 3);
  const start = dayjs.utc().month(q * 3).startOf('month');
  const end = start.add(3, 'month').subtract(1, 'day');
  return [start, end];
}

export function presetLastQuarter(): [Dayjs, Dayjs] {
  const now = dayjs.utc();
  const q = Math.floor(now.month() / 3) - 1;
  const year = q < 0 ? now.year() - 1 : now.year();
  const month = q < 0 ? 9 : q * 3;
  const start = dayjs.utc().year(year).month(month).startOf('month');
  const end = start.add(3, 'month').subtract(1, 'day');
  return [start, end];
}

/** Rolling UTC calendar window ending today (inclusive). */
export function presetLast7Days(): [Dayjs, Dayjs] {
  const end = dayjs.utc().startOf('day');
  return [end.subtract(6, 'day'), end];
}

export function presetLast15Days(): [Dayjs, Dayjs] {
  const end = dayjs.utc().startOf('day');
  return [end.subtract(14, 'day'), end];
}

export function monthRangeToUsageQuery(range: [Dayjs, Dayjs]) {
  return { from: toIsoUtcStart(range[0]), to: toIsoUtcEndExclusive(range[1]) };
}

/** Wide window for usage aggregation when the overview selects all history. */
export function allTimeUsageRangeUtc(): [Dayjs, Dayjs] {
  return [dayjs.utc('1970-01-01'), dayjs.utc().startOf('day')];
}

function inclusiveUtcDays(start: Dayjs, end: Dayjs): number {
  return end.utc().startOf('day').diff(start.utc().startOf('day'), 'day') + 1;
}

/**
 * Window immediately before `range` for overview deltas.
 * An open this-month / this-quarter (end still in the future) is compared with the
 * same number of elapsed UTC days in the previous period, not the whole previous period.
 */
export function previousComparisonRangeUtc(range: [Dayjs, Dayjs], now = dayjs.utc()): [Dayjs, Dayjs] {
  const preset = matchUsagePeriodPreset(range);
  const start = range[0].utc().startOf('day');
  const nominalEnd = range[1].utc().startOf('day');
  const today = now.utc().startOf('day');
  const openEnded =
    (preset === 'thisMonth' || preset === 'thisQuarter') && nominalEnd.isAfter(today);
  if (openEnded) {
    const effectiveEnd = today.isBefore(start) ? start : today;
    const elapsed = inclusiveUtcDays(start, effectiveEnd);
    const prevStart =
      preset === 'thisMonth'
        ? start.subtract(1, 'month').startOf('month')
        : start.subtract(3, 'month').startOf('month');
    return [prevStart, prevStart.add(elapsed - 1, 'day')];
  }
  if (preset === 'thisMonth' || preset === 'lastMonth') {
    const prev = start.subtract(1, 'month').startOf('month');
    return [prev.startOf('month'), prev.endOf('month')];
  }
  if (preset === 'thisQuarter' || preset === 'lastQuarter') {
    const prev = start.subtract(3, 'month').startOf('month');
    return [prev, prev.add(3, 'month').subtract(1, 'day')];
  }
  const days = inclusiveUtcDays(start, nominalEnd);
  const prevEnd = start.subtract(1, 'day');
  return [prevEnd.subtract(days - 1, 'day'), prevEnd];
}

/** Compact UTC day span for delta labels, e.g. `9/1–9/12`. */
export function formatUtcDaySpan(range: [Dayjs, Dayjs]): string {
  const start = range[0].utc();
  const end = range[1].utc();
  if (start.isSame(end, 'day')) return start.format('M/D');
  if (start.isSame(end, 'year')) return `${start.format('M/D')}–${end.format('M/D')}`;
  return `${start.format('YYYY/M/D')}–${end.format('YYYY/M/D')}`;
}

/** Parse usage-style period query back to inclusive UTC day range for DatePicker. */
export function usageQueryToDayRange(from: string, to: string): [Dayjs, Dayjs] {
  const start = dayjs.utc(from);
  const endExclusive = dayjs.utc(to);
  const endInclusive = endExclusive.subtract(1, 'millisecond').startOf('day');
  return [start.startOf('day'), endInclusive];
}

export type UsagePeriodPreset =
  | 'all'
  | 'last7d'
  | 'last15d'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisQuarter'
  | 'lastQuarter'
  | 'custom';

function rangesSameUtcDay(a: [Dayjs, Dayjs], b: [Dayjs, Dayjs]): boolean {
  return a[0].utc().isSame(b[0].utc(), 'day') && a[1].utc().isSame(b[1].utc(), 'day');
}

export function usagePeriodPresetRange(key: Exclude<UsagePeriodPreset, 'custom' | 'all'>): [Dayjs, Dayjs] {
  switch (key) {
    case 'last7d':
      return presetLast7Days();
    case 'last15d':
      return presetLast15Days();
    case 'thisMonth':
      return presetThisMonth();
    case 'lastMonth':
      return presetLastMonth();
    case 'thisQuarter':
      return presetThisQuarter();
    case 'lastQuarter':
      return presetLastQuarter();
  }
}

export function matchUsagePeriodPreset(
  range: [Dayjs, Dayjs] | null | undefined,
  opts?: { allowAll?: boolean },
): UsagePeriodPreset {
  if (!range) {
    return opts?.allowAll ? 'all' : 'custom';
  }
  const presets: Exclude<UsagePeriodPreset, 'custom' | 'all'>[] = [
    'last7d',
    'last15d',
    'thisMonth',
    'lastMonth',
    'thisQuarter',
    'lastQuarter',
  ];
  for (const key of presets) {
    if (rangesSameUtcDay(range, usagePeriodPresetRange(key))) {
      return key;
    }
  }
  return 'custom';
}

export const USAGE_PERIOD_PRESET_LABELS: Record<UsagePeriodPreset, string> = {
  all: '全部时间',
  last7d: '最近 7 天',
  last15d: '最近 15 天',
  thisMonth: '本月',
  lastMonth: '上月',
  thisQuarter: '本季度',
  lastQuarter: '上季度',
  custom: '自定义',
};
