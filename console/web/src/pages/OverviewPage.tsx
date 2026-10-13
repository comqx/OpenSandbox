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

import {
  Alert,
  Button,
  Card,
  Empty,
  Progress,
  Space,
  Spin,
  Statistic,
  Table,
  Typography,
} from 'antd';
import {
  ClockCircleOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';

import { adminApi, ApiError, historyApi, sandboxApi } from '../api/client';
import { AdminTenantSelect, ALL_TENANTS, tenantFilterToQuery } from '../components/AdminTenantSelect';
import { USAGE_METRIC_HINTS, UsageMetricTitle } from '../components/UsageMetricTitle';
import { UsagePeriodFilterBar } from '../components/UsagePeriodFilterBar';
import type { HistoryTenantStatsRow, SandboxHistoryStats, TenantUsageRow } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { SandboxStateTag, TenantTag } from '../components/SemanticTags';
import { formatDuration } from '../utils/format';
import { historySandboxesPath, historyUsagePath } from '../utils/historyLinks';
import {
  USAGE_PERIOD_PRESET_LABELS,
  allTimeUsageRangeUtc,
  currentMonthRangeUtc,
  formatUtcDaySpan,
  matchUsagePeriodPreset,
  monthRangeToUsageQuery,
  previousComparisonRangeUtc,
  type UsagePeriodPreset,
} from '../utils/usagePeriod';

import './OverviewPage.css';

function usageSectionTitle(preset: UsagePeriodPreset): string {
  switch (preset) {
    case 'thisMonth':
      return '本月用量（limits 口径）';
    case 'lastMonth':
      return '上月用量（limits 口径）';
    case 'thisQuarter':
      return '本季度用量（limits 口径）';
    case 'lastQuarter':
      return '上季度用量（limits 口径）';
    case 'all':
      return '历史用量（limits 口径）';
    default:
      return '区间用量（limits 口径）';
  }
}

function usageTenantTitle(preset: UsagePeriodPreset): string {
  switch (preset) {
    case 'thisMonth':
      return '本月租户用量统计';
    case 'lastMonth':
      return '上月租户用量统计';
    case 'thisQuarter':
      return '本季度租户用量统计';
    case 'lastQuarter':
      return '上季度租户用量统计';
    case 'all':
      return '历史租户用量统计';
    default:
      return '区间租户用量统计';
  }
}

function periodSubtitle(range: [Dayjs, Dayjs] | null, preset: UsagePeriodPreset): string {
  if (!range || preset === 'all') return '历史累计（UTC）';
  if (preset === 'thisMonth' || preset === 'lastMonth') {
    return `${USAGE_PERIOD_PRESET_LABELS[preset]} ${range[0].utc().format('YYYY-MM')}（UTC）`;
  }
  return `${USAGE_PERIOD_PRESET_LABELS[preset]} ${range[0].utc().format('YYYY-MM-DD')} – ${range[1].utc().format('YYYY-MM-DD')}（UTC）`;
}

function shareProgressColor(percent: number): string {
  if (percent >= 40) return '#1677ff';
  if (percent >= 20) return '#13c2c2';
  if (percent >= 10) return '#52c41a';
  return '#faad14';
}

type LiveCounts = {
  total: number;
  running: number;
};

type UsageTotals = {
  sandboxCount?: number;
  overlapSeconds?: number;
  cpuCoreSeconds?: number;
  memoryGiSeconds?: number;
  limitsMissing?: number;
};

function pctChange(current: number, previous: number | undefined): number | null {
  if (previous === undefined) return null;
  if (previous === 0) {
    if (current === 0) return 0;
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function DeltaTag({
  current,
  previous,
  basis,
}: {
  current: number;
  previous?: number;
  basis?: string;
}) {
  const pct = pctChange(current, previous);
  const basisNode = basis ? <span className="overview-kpi-delta-basis">{basis}</span> : null;
  if (pct === null) {
    if (previous === 0 && current > 0) {
      return (
        <span className="overview-kpi-delta up">
          ↑ 新
          {basisNode}
        </span>
      );
    }
    return null;
  }
  if (Math.abs(pct) < 0.05) {
    return (
      <span className="overview-kpi-delta flat">
        — 0%{basisNode}
      </span>
    );
  }
  const up = pct > 0;
  return (
    <span className={`overview-kpi-delta ${up ? 'up' : 'down'}`}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(0)}%{basisNode}
    </span>
  );
}

function UsageKpiCard(props: {
  icon: React.ReactNode;
  iconTone: 'blue' | 'purple' | 'cyan' | 'orange';
  title: React.ReactNode;
  displayValue: string;
  numericCurrent: number;
  numericPrevious?: number;
  deltaBasis?: string;
  detailTo?: string;
}) {
  const { icon, iconTone, title, displayValue, numericCurrent, numericPrevious, deltaBasis, detailTo } =
    props;
  const valueNode =
    detailTo && numericCurrent > 0 ? (
      <Link to={detailTo} className="overview-kpi-value-link">
        {displayValue}
      </Link>
    ) : (
      displayValue
    );
  return (
    <Card className="overview-kpi-card" bordered={false}>
      <div className="overview-kpi-top">
        <div className={`overview-kpi-icon ${iconTone}`}>{icon}</div>
        <DeltaTag current={numericCurrent} previous={numericPrevious} basis={deltaBasis} />
      </div>
      <div className="overview-kpi-title">{title}</div>
      <div className="overview-kpi-value">{valueNode}</div>
    </Card>
  );
}

function LiveRuntimePanel({
  total,
  running,
  isAdmin,
  listHref,
}: {
  total: number;
  running: number;
  isAdmin: boolean;
  listHref: string;
}) {
  return (
    <Card className="overview-live-card" bordered={false}>
      <div className="overview-live-stats">
        <div className="overview-live-stat overview-live-stat--total">
          <div className="overview-live-stat-head">
            <div className="overview-live-stat-icon overview-live-stat-icon--blue" aria-hidden>
              <CloudServerOutlined />
            </div>
            <Typography.Text type="secondary" className="overview-live-stat-label">
              列表中的沙箱数
            </Typography.Text>
          </div>
          <div className="overview-live-stat-value overview-live-stat-value--blue">{total}</div>
            <Typography.Text type="secondary" className="overview-live-stat-foot">
            每个租户最新 200 条
          </Typography.Text>
        </div>
        <div className="overview-live-stat-divider" aria-hidden />
        <div
          className={`overview-live-stat overview-live-stat--running${
            running > 0 ? ' overview-live-stat--running-active' : ''
          }`}
        >
          <div className="overview-live-stat-head">
            <div
              className={`overview-live-stat-icon${
                running > 0 ? ' overview-live-stat-icon--green' : ' overview-live-stat-icon--muted'
              }`}
              aria-hidden
            >
              <PlayCircleOutlined />
            </div>
            <span className="overview-live-stat-label-row">
              <SandboxStateTag state="Running" />
            </span>
          </div>
          <div
            className={`overview-live-stat-value${
              running > 0 ? ' overview-live-stat-value--green' : ' overview-live-stat-value--muted'
            }`}
          >
            {running}
          </div>
          <Typography.Text type="secondary" className="overview-live-stat-foot">
            以上列表中的 Running
          </Typography.Text>
        </div>
      </div>
      <div className="overview-live-hint">
        <Typography.Text type="secondary">
          不受顶部时间范围影响。数据来自 Lifecycle 实时接口，与下方历史统计独立。
          {isAdmin ? ' 可按租户缩小范围。' : ''}
        </Typography.Text>
        <Link to={listHref} className="overview-live-hint-link">
          打开实时列表 →
        </Link>
      </div>
    </Card>
  );
}

export function OverviewPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tenantFilter, setTenantFilter] = useState(ALL_TENANTS);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(() => currentMonthRangeUtc());
  const [loading, setLoading] = useState(true);
  const [historyOff, setHistoryOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SandboxHistoryStats | null>(null);
  const [monthTenants, setMonthTenants] = useState<TenantUsageRow[]>([]);
  const [monthTotals, setMonthTotals] = useState<UsageTotals | null>(null);
  const [prevMonthTotals, setPrevMonthTotals] = useState<UsageTotals | null>(null);
  const [live, setLive] = useState<LiveCounts | null>(null);

  const tenantQuery = isAdmin ? tenantFilterToQuery(tenantFilter) : undefined;
  const liveSeq = useRef(0);
  const historySeq = useRef(0);

  useEffect(() => {
    const seq = ++liveSeq.current;
    void (async () => {
      try {
        const data = isAdmin
          ? await adminApi.sandboxes({ pageSize: 200, tenant: tenantQuery })
          : await sandboxApi.list({ pageSize: 200 });
        if (seq !== liveSeq.current) return;
        const items = data.items ?? [];
        setLive({
          total: items.length,
          running: items.filter((s) => s.status?.state === 'Running').length,
        });
      } catch (e) {
        if (seq !== liveSeq.current) return;
        setError(e instanceof Error ? e.message : '加载实时沙箱失败');
      }
    })();
  }, [isAdmin, tenantQuery]);

  useEffect(() => {
    const seq = ++historySeq.current;
    setLoading(true);
    setError(null);
    const usageQuery = monthRangeToUsageQuery(range ?? allTimeUsageRangeUtc());
    const prevUsageQuery = range ? monthRangeToUsageQuery(previousComparisonRangeUtc(range)) : null;
    const tenantArg = tenantQuery ? { tenant: tenantQuery } : {};
    void (async () => {
      try {
        const [st, usage, prevUsage] = await Promise.all([
          historyApi.stats({ ...usageQuery, ...tenantArg }),
          historyApi.usage({ ...usageQuery, ...tenantArg }),
          prevUsageQuery
            ? historyApi.usage({ ...prevUsageQuery, ...tenantArg })
            : Promise.resolve(null),
        ]);
        if (seq !== historySeq.current) return;
        if (st.enabled === false) {
          setHistoryOff(true);
          return;
        }
        setHistoryOff(false);
        setStats(st);
        setMonthTotals(usage.totals ?? null);
        setPrevMonthTotals(prevUsage?.totals ?? null);
        setMonthTenants(usage.tenants ?? []);
      } catch (e) {
        if (seq !== historySeq.current) return;
        if (e instanceof ApiError && e.status === 503) {
          setHistoryOff(true);
          return;
        }
        setError(e instanceof Error ? e.message : '加载概览失败');
      } finally {
        if (seq === historySeq.current) setLoading(false);
      }
    })();
  }, [range, tenantQuery]);

  const periodPreset = useMemo(() => matchUsagePeriodPreset(range, { allowAll: true }), [range]);

  const usageQuery = useMemo(
    () => monthRangeToUsageQuery(range ?? allTimeUsageRangeUtc()),
    [range],
  );

  const usagePeriod = useMemo(() => (range ? usageQuery : null), [range, usageQuery]);

  const comparisonBasis = useMemo(() => {
    if (!range) return undefined;
    return `较 ${formatUtcDaySpan(previousComparisonRangeUtc(range))}`;
  }, [range]);

  const historyLink = useMemo(
    () =>
      historySandboxesPath(
        range
          ? { from: usagePeriod?.from, to: usagePeriod?.to, tenant: tenantQuery }
          : { allTime: true, tenant: tenantQuery },
      ),
    [range, tenantQuery, usagePeriod?.from, usagePeriod?.to],
  );

  const usageLink = useMemo(
    () => historyUsagePath({ from: usageQuery.from, to: usageQuery.to, tenant: tenantQuery }),
    [tenantQuery, usageQuery.from, usageQuery.to],
  );

  const liveListHref = isAdmin
    ? tenantQuery
      ? `/admin/sandboxes?tenant=${encodeURIComponent(tenantQuery)}`
      : '/admin/sandboxes'
    : '/sandboxes';

  const countsAreEmpty =
    !historyOff &&
    stats &&
    (stats.totalRecords ?? 0) === 0 &&
    (monthTotals?.sandboxCount ?? 0) === 0;
  const historyEmpty = Boolean(countsAreEmpty && !range);
  const periodEmpty = Boolean(countsAreEmpty && range);

  const tenantColumns: ColumnsType<TenantUsageRow> = useMemo(
    () => [
      {
        title: '租户',
        dataIndex: 'tenant',
        width: 140,
        render: (t: string) => (
          <TenantTag tenant={t} className="overview-tenant-tag" />
        ),
      },
      {
        title: (
          <UsageMetricTitle label="沙箱数" hint={USAGE_METRIC_HINTS.sandboxCount} />
        ),
        dataIndex: 'sandboxCount',
        width: 120,
        render: (v: number, row) =>
          v > 0 ? (
            <Link
              to={historySandboxesPath(
                range
                  ? { from: usagePeriod?.from, to: usagePeriod?.to, tenant: row.tenant }
                  : { allTime: true, tenant: row.tenant },
              )}
            >
              <Typography.Text strong className="overview-tenant-metric overview-tenant-metric--count">
                {v}
              </Typography.Text>
            </Link>
          ) : (
            <Typography.Text strong className="overview-tenant-metric overview-tenant-metric--count">
              {v}
            </Typography.Text>
          ),
      },
      {
        title: <UsageMetricTitle label="占用时长" hint={USAGE_METRIC_HINTS.overlapSeconds} />,
        dataIndex: 'overlapSeconds',
        render: (v: number) => (
          <span className="overview-tenant-metric overview-tenant-metric--time">{formatDuration(v)}</span>
        ),
      },
      {
        title: <UsageMetricTitle label="CPU·秒" hint={USAGE_METRIC_HINTS.cpuCoreSeconds} />,
        dataIndex: 'cpuCoreSeconds',
        render: (v: number) => (
          <span className="overview-tenant-metric overview-tenant-metric--cpu">
            {v.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </span>
        ),
      },
      {
        title: <UsageMetricTitle label="内存·Gi·秒" hint={USAGE_METRIC_HINTS.memoryGiSeconds} />,
        dataIndex: 'memoryGiSeconds',
        render: (v: number) => (
          <span className="overview-tenant-metric overview-tenant-metric--mem">
            {v.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </span>
        ),
      },
      {
        title: '时长占比',
        key: 'share',
        width: 140,
        render: (_, r) => {
          const pct = r.sharePercent?.time ?? 0;
          return (
            <div className="overview-tenant-share">
              <Progress
                percent={pct}
                size="small"
                showInfo={false}
                strokeColor={shareProgressColor(pct)}
                trailColor="rgba(0,0,0,0.06)"
              />
              <Typography.Text strong className="overview-tenant-share-pct">
                {pct}%
              </Typography.Text>
            </div>
          );
        },
      },
    ],
    [range, usagePeriod?.from, usagePeriod?.to],
  );

  const historyTenantColumns: ColumnsType<HistoryTenantStatsRow> = useMemo(
    () => [
      {
        title: '租户',
        dataIndex: 'tenant',
        width: 140,
        render: (t: string) => <TenantTag tenant={t} className="overview-tenant-tag" />,
      },
      {
        title: range ? '重叠记录数' : '历史记录数',
        dataIndex: 'totalRecords',
        width: 120,
        render: (v: number) => (
          <Typography.Text strong className="overview-tenant-metric overview-tenant-metric--count">
            {v}
          </Typography.Text>
        ),
      },
      {
        title: '进行中',
        dataIndex: 'activeRecords',
        width: 100,
        render: (v: number) => (
          <span className="overview-tenant-metric overview-tenant-metric--active">{v}</span>
        ),
      },
      {
        title: range ? '区间内时长' : '累计运行时长',
        dataIndex: 'totalWallClockSeconds',
        render: (v: number) => (
          <span className="overview-tenant-metric overview-tenant-metric--time">{formatDuration(v)}</span>
        ),
      },
      {
        title: range ? '区间内平均时长' : '平均运行时长',
        dataIndex: 'avgWallClockSeconds',
        render: (v: number, row) => (
          <span className="overview-tenant-metric overview-tenant-metric--time">
            {row.totalRecords > 0 ? formatDuration(v) : '—'}
          </span>
        ),
      },
    ],
    [range],
  );

  const quickLinks: { to: string; label: string }[] = isAdmin
    ? [
        { to: liveListHref, label: '全局沙箱（实时）' },
        { to: historyLink, label: '申请历史' },
        { to: usageLink, label: '用量分摊' },
        { to: '/platform/health', label: '组件健康' },
      ]
    : [
        { to: '/sandboxes', label: '我的沙箱（实时）' },
        { to: historyLink, label: '申请历史' },
        { to: usageLink, label: '用量分摊' },
        { to: '/sandboxes/new', label: '创建沙箱' },
      ];

  const sandboxCount = monthTotals?.sandboxCount ?? 0;
  const overlapSec = monthTotals?.overlapSeconds ?? 0;
  const cpuSec = monthTotals?.cpuCoreSeconds ?? 0;
  const memGiSec = monthTotals?.memoryGiSeconds ?? 0;

  return (
    <div className="overview-page">
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="start" wrap>
        <div>
          <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 6, fontWeight: 600 }}>
            概览
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 14 }}>
            {isAdmin ? '平台视角' : `租户 ${user?.tenant ?? ''}`} · {periodSubtitle(range, periodPreset)}
          </Typography.Text>
        </div>
        <Space wrap>
          <UsagePeriodFilterBar
            range={range}
            onRangeChange={setRange}
            allowAllTime
            allTimeLabel="历史累计"
          />
          {isAdmin && <AdminTenantSelect value={tenantFilter} onChange={setTenantFilter} width={220} />}
        </Space>
      </Space>

      <nav className="overview-quick-nav" aria-label="快捷入口">
        {quickLinks.map((item) => (
          <Link key={item.to} to={item.to}>
            <Button block className="overview-quick-nav-btn">
              {item.label}
            </Button>
          </Link>
        ))}
      </nav>

      {historyOff && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="历史统计未启用"
          description="配置 BFF_HISTORY_ENABLED 与 BFF_HISTORY_DATABASE_URL 并重启 Console BFF 后，方可看到本月用量与历史累计。"
        />
      )}
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}

      <Spin spinning={loading}>
        <Typography.Title level={5} className="overview-section-title">
          当前运行（Lifecycle 实时）
        </Typography.Title>
        <LiveRuntimePanel
          total={live?.total ?? 0}
          running={live?.running ?? 0}
          isAdmin={isAdmin}
          listHref={liveListHref}
        />

        {!historyOff && (
          <>
            <div className="overview-block">
            <div className="overview-section-head">
              <Typography.Title level={5} className="overview-section-title" style={{ marginBottom: 0 }}>
                {usageSectionTitle(periodPreset)}
              </Typography.Title>
              <Link to={usageLink}>详细分摊 →</Link>
            </div>
            <div className="overview-subsection">
            {isAdmin && !tenantQuery && monthTenants.length > 0 ? (
              <div className="overview-subsection-label">指标</div>
            ) : null}
            <div className="overview-kpi-grid">
              <UsageKpiCard
                icon={<CloudServerOutlined />}
                iconTone="blue"
                title={<UsageMetricTitle label="沙箱数" hint={USAGE_METRIC_HINTS.sandboxCount} />}
                displayValue={String(sandboxCount)}
                numericCurrent={sandboxCount}
                numericPrevious={prevMonthTotals?.sandboxCount}
                deltaBasis={comparisonBasis}
                detailTo={historyLink}
              />
              <UsageKpiCard
                icon={<ClockCircleOutlined />}
                iconTone="purple"
                title={<UsageMetricTitle label="占用时长" hint={USAGE_METRIC_HINTS.overlapSeconds} />}
                displayValue={formatDuration(overlapSec)}
                numericCurrent={overlapSec}
                numericPrevious={prevMonthTotals?.overlapSeconds}
                deltaBasis={comparisonBasis}
              />
              <UsageKpiCard
                icon={<ThunderboltOutlined />}
                iconTone="cyan"
                title={<UsageMetricTitle label="CPU·秒" hint={USAGE_METRIC_HINTS.cpuCoreSeconds} />}
                displayValue={cpuSec.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                numericCurrent={cpuSec}
                numericPrevious={prevMonthTotals?.cpuCoreSeconds}
                deltaBasis={comparisonBasis}
              />
              <UsageKpiCard
                icon={<DatabaseOutlined />}
                iconTone="orange"
                title={<UsageMetricTitle label="内存·Gi·秒" hint={USAGE_METRIC_HINTS.memoryGiSeconds} />}
                displayValue={memGiSec.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                numericCurrent={memGiSec}
                numericPrevious={prevMonthTotals?.memoryGiSeconds}
                deltaBasis={comparisonBasis}
              />
            </div>
            {(monthTotals?.limitsMissing ?? 0) > 0 ? (
              <Typography.Paragraph type="secondary" className="overview-limits-note">
                {monthTotals?.limitsMissing} 条记录没有创建时的 resourceLimits，未计入 CPU·秒和内存·Gi·秒。
              </Typography.Paragraph>
            ) : null}
            </div>

            {isAdmin && !tenantQuery && monthTenants.length > 0 && (
              <div className="overview-subsection">
                <div className="overview-subsection-label">{usageTenantTitle(periodPreset)}</div>
                <Card className="overview-tenant-card" bordered={false}>
                  <Table
                    className="overview-tenant-table"
                    size="middle"
                    rowKey="tenant"
                    pagination={false}
                    columns={tenantColumns}
                    dataSource={monthTenants}
                    rowClassName={(_, index) =>
                      index % 2 === 0 ? 'overview-tenant-row-even' : 'overview-tenant-row-odd'
                    }
                  />
                </Card>
              </div>
            )}
            </div>

            <div className="overview-block">
            <Typography.Title level={5} className="overview-section-title">
              {range ? '区间记录' : '历史累计'}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
              {range
                ? '与所选区间有重叠的记录。时长只计落在区间内的部分。进行中仍指当前未结束。'
                : '全部历史里与时间轴有重叠的记录。时长含仍在运行的沙箱。'}
            </Typography.Paragraph>
            <div className="overview-subsection">
            {isAdmin && !tenantQuery && (stats?.tenants?.length ?? 0) > 0 ? (
              <div className="overview-subsection-label">指标</div>
            ) : null}
            <div className="overview-history-grid">
              <Card className="overview-history-card" bordered={false}>
                <Statistic title={range ? '重叠记录数' : '历史记录总数'} value={stats?.totalRecords ?? 0} />
              </Card>
              <Card className="overview-history-card" bordered={false}>
                <Statistic title="进行中（未结束）" value={stats?.activeRecords ?? 0} />
              </Card>
              <Card className="overview-history-card" bordered={false}>
                <Statistic
                  title={range ? '区间内时长' : '累计运行时长'}
                  value={formatDuration(stats?.totalWallClockSeconds ?? 0)}
                />
              </Card>
              <Card className="overview-history-card" bordered={false}>
                <Statistic
                  title={range ? '区间内平均时长' : '平均运行时长'}
                  value={
                    (stats?.totalRecords ?? 0) > 0 ? formatDuration(stats?.avgWallClockSeconds) : '—'
                  }
                />
              </Card>
            </div>
            </div>
            {isAdmin && !tenantQuery && (stats?.tenants?.length ?? 0) > 0 && (
              <div className="overview-subsection">
                <div className="overview-subsection-label">{range ? '各租户区间记录' : '各租户总计'}</div>
                <Card className="overview-tenant-card" bordered={false}>
                  <Table
                    className="overview-tenant-table"
                    size="middle"
                    rowKey="tenant"
                    pagination={false}
                    columns={historyTenantColumns}
                    dataSource={stats?.tenants}
                    rowClassName={(_, index) =>
                      index % 2 === 0 ? 'overview-tenant-row-even' : 'overview-tenant-row-odd'
                    }
                  />
                </Card>
              </div>
            )}
            </div>
          </>
        )}

        {periodEmpty && (
          <Typography.Paragraph type="secondary">该区间没有重叠的历史记录。</Typography.Paragraph>
        )}

        {historyEmpty && (
          <Empty
            style={{ marginTop: 32 }}
            description={
              <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'left' }}>
                <Typography.Paragraph strong>为什么历史是 0？</Typography.Paragraph>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  数据写在 PostgreSQL 表 <code>sandbox_lifecycle_history</code>。Server 开启生命周期审计后，SDK 创建也会入库；否则主要依赖 Console 或对账。
                </Typography.Paragraph>
                <ul style={{ paddingLeft: 20, margin: 0, color: 'rgba(0,0,0,0.45)' }}>
                  <li>打开本页会按租户拉 Lifecycle 现网列表并入库；若仍为 0，可能当前无沙箱或 Lifecycle 对账失败</li>
                  <li>启用历史之前已销毁的沙箱无法回填</li>
                  <li>若上方 Running &gt; 0 但历史仍为 0，检查 BFF DSN、租户 API Key、BFF 日志 reconcile / upsert 错误</li>
                </ul>
                <Space style={{ marginTop: 16 }}>
                  {isAdmin ? (
                    <Link to="/admin/sandboxes">
                      <Button type="primary">去看实时沙箱</Button>
                    </Link>
                  ) : (
                    <>
                      <Link to="/sandboxes/new">
                        <Button type="primary">创建沙箱</Button>
                      </Link>
                      <Link to="/sandboxes">
                        <Button>打开沙箱列表</Button>
                      </Link>
                    </>
                  )}
                </Space>
              </div>
            }
          />
        )}
      </Spin>
    </div>
  );
}
