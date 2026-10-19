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

import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

import type { CreatedBucket, CreatedSeriesRow } from '../utils/createdTrend';

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const TENANT_COLORS = [
  '#1677ff',
  '#2f54eb',
  '#722ed1',
  '#13c2c2',
  '#52c41a',
  '#fa8c16',
  '#faad14',
  '#eb2f96',
];

const TOTAL_COLOR = '#10239e';

function tenantColor(tenant: string): string {
  if (tenant === '其他') return '#8c8c8c';
  let hash = 0;
  for (let i = 0; i < tenant.length; i++) hash = (hash * 31 + tenant.charCodeAt(i)) >>> 0;
  return TENANT_COLORS[hash % TENANT_COLORS.length];
}

function axisLabel(point: string, bucket: CreatedBucket): string {
  return bucket === 'day' ? point.slice(5) : point;
}

function buildOption(
  points: string[],
  series: CreatedSeriesRow[],
  totals: number[],
  bucket: CreatedBucket,
  showTotal: boolean,
): EChartsCoreOption {
  const bars = series.map((row) => ({
    id: `tenant:${row.tenant}`,
    name: row.tenant,
    type: 'bar' as const,
    stack: 'created',
    data: row.counts,
    barMaxWidth: 28,
    itemStyle: { color: tenantColor(row.tenant) },
    emphasis: { focus: 'series' as const },
  }));
  const line = showTotal
    ? [
        {
          id: 'created-total',
          name: '合计',
          type: 'line' as const,
          data: totals,
          symbol: 'circle',
          symbolSize: 7,
          z: 3,
          itemStyle: { color: TOTAL_COLOR },
          lineStyle: { width: 2, color: TOTAL_COLOR },
        },
      ]
    : [];
  return {
    color: TENANT_COLORS,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { type: 'scroll', top: 0 },
    grid: { left: 48, right: 16, top: 48, bottom: 28 },
    xAxis: {
      type: 'category',
      data: points,
      axisLabel: {
        formatter: (value: string) => axisLabel(value, bucket),
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      name: '创建数',
      minInterval: 1,
    },
    series: [...bars, ...line],
  };
}

export function CreatedTrendChart({
  points,
  series,
  totals,
  bucket,
  showTotal,
}: {
  points: string[];
  series: CreatedSeriesRow[];
  totals: number[];
  bucket: CreatedBucket;
  showTotal: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host);
    chart.setOption(buildOption(points, series, totals, bucket, showTotal));
    if (showTotal) {
      chart.on('legendselectchanged', (raw: unknown) => {
        const selected = (raw as { selected?: Record<string, boolean> }).selected ?? {};
        const next = points.map((_, index) =>
          series.reduce((sum, row) => {
            if (selected[row.tenant] === false) return sum;
            return sum + (row.counts[index] ?? 0);
          }, 0),
        );
        chart.setOption({ series: [{ id: 'created-total', data: next }] });
      });
    }
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [bucket, points, series, showTotal, totals]);

  return <div ref={hostRef} className="overview-trend-chart" />;
}
