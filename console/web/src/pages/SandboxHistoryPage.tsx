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

import { SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Input, Row, Space, Statistic, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { historyApi } from '../api/client';
import { AdminTenantSelect, ALL_TENANTS, tenantFilterToQuery } from '../components/AdminTenantSelect';
import { sandboxLabelsColumn } from '../components/SandboxLabelTags';
import { consoleTagTableCellProps, SandboxStateTag, TenantTag } from '../components/SemanticTags';
import { UsagePeriodFilterBar } from '../components/UsagePeriodFilterBar';
import type { SandboxHistoryItem, SandboxHistoryStats } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, formatDuration } from '../utils/format';
import { currentMonthRangeUtc, monthRangeToUsageQuery, usageQueryToDayRange } from '../utils/usagePeriod';

const HISTORY_PAGE_SIZE = 20;

export function SandboxHistoryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const periodFrom = searchParams.get('from') ?? undefined;
  const periodTo = searchParams.get('to') ?? undefined;
  const periodActive = Boolean(periodFrom && periodTo);
  const urlTenant = searchParams.get('tenant');
  const periodAll = searchParams.get('period') === 'all';
  const defaultedPeriod = useRef(false);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<SandboxHistoryItem[]>([]);
  const [stats, setStats] = useState<SandboxHistoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantFilter, setTenantFilter] = useState(ALL_TENANTS);
  const [idInput, setIdInput] = useState('');
  const [idQuery, setIdQuery] = useState('');
  const [labelQuery, setLabelQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [recLoading, setRecLoading] = useState(false);
  const [savedRunId, setSavedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (defaultedPeriod.current) return;
    defaultedPeriod.current = true;
    if (periodAll || periodFrom || periodTo) return;
    const next = new URLSearchParams(searchParams);
    const q = monthRangeToUsageQuery(currentMonthRangeUtc());
    next.set('from', q.from);
    next.set('to', q.to);
    setSearchParams(next, { replace: true });
  }, [periodAll, periodFrom, periodTo, searchParams, setSearchParams]);

  useEffect(() => {
    if (isAdmin && urlTenant) {
      setTenantFilter(urlTenant);
    }
  }, [isAdmin, urlTenant]);

  useEffect(() => {
    const handle = window.setTimeout(() => setIdQuery(idInput.trim().slice(0, 200)), 300);
    return () => window.clearTimeout(handle);
  }, [idInput]);

  useEffect(() => {
    setPage(1);
  }, [tenantFilter, periodFrom, periodTo, labelQuery, idQuery]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const tenant = isAdmin ? tenantFilterToQuery(tenantFilter) : undefined;
        const periodQuery =
          periodFrom && periodTo ? { from: periodFrom, to: periodTo } : undefined;
        const [list, st] = await Promise.all([
          historyApi.listSandboxes({
            page,
            pageSize: HISTORY_PAGE_SIZE,
            ...(tenant ? { tenant } : {}),
            ...(labelQuery ? { label: labelQuery } : {}),
            ...(idQuery ? { sandboxId: idQuery } : {}),
            ...periodQuery,
          }),
          periodActive
            ? Promise.resolve({ enabled: true } as SandboxHistoryStats)
            : historyApi.stats(tenant ? { tenant } : undefined),
        ]);
        setItems(list.items ?? []);
        setTotalItems(list.pagination?.totalItems ?? 0);
        setStats(periodActive ? null : st);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载历史失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [isAdmin, tenantFilter, page, periodFrom, periodTo, periodActive, labelQuery, idQuery]);

  const dayRange = useMemo((): [Dayjs, Dayjs] | null => {
    if (!periodFrom || !periodTo) return null;
    return usageQueryToDayRange(periodFrom, periodTo);
  }, [periodFrom, periodTo]);

  const syncTenantToUrl = (nextTenant: string) => {
    setTenantFilter(nextTenant);
    if (!isAdmin) return;
    const next = new URLSearchParams(searchParams);
    const q = tenantFilterToQuery(nextTenant);
    if (q) next.set('tenant', q);
    else next.delete('tenant');
    setSearchParams(next, { replace: true });
  };

  const applyDayRange = (range: [Dayjs, Dayjs]) => {
    const q = monthRangeToUsageQuery(range);
    const next = new URLSearchParams(searchParams);
    next.delete('period');
    next.set('from', q.from);
    next.set('to', q.to);
    setSearchParams(next, { replace: true });
  };

  const clearPeriodFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    next.delete('to');
    next.set('period', 'all');
    setSearchParams(next, { replace: true });
  };

  const loadRecommendations = async () => {
    setRecLoading(true);
    setSavedRunId(null);
    try {
      const tenant = isAdmin ? tenantFilterToQuery(tenantFilter) : undefined;
      const saved = await historyApi.createResourceRecommendationRun({
        ...(periodActive && periodFrom && periodTo
          ? { from: periodFrom, to: periodTo }
          : { window: '7d' }),
        ...(labelQuery ? { label: labelQuery } : {}),
        ...(idQuery ? { sandboxId: idQuery } : {}),
        ...(tenant ? { tenant } : {}),
      });
      setSavedRunId(saved.id);
      message.success('已提交计算，请到资源推荐查看结果');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '资源推荐计算失败');
    } finally {
      setRecLoading(false);
    }
  };

  const onPeriodRangeChange = (range: [Dayjs, Dayjs] | null) => {
    if (!range) {
      clearPeriodFilter();
      return;
    }
    applyDayRange(range);
  };

  const sandboxDetailPath = (r: SandboxHistoryItem) =>
    isAdmin
      ? `/sandboxes/${r.sandboxId}?tenant=${encodeURIComponent(r.tenant ?? '')}`
      : `/sandboxes/${r.sandboxId}`;

  const sandboxMonitorLogsPath = (r: SandboxHistoryItem) => {
    const base = sandboxDetailPath(r);
    return `${base}${base.includes('?') ? '&' : '?'}tab=logs`;
  };

  const columns: ColumnsType<SandboxHistoryItem> = [
    {
      title: '沙箱 ID',
      dataIndex: 'sandboxId',
      ellipsis: true,
      render: (id: string, r) => <Link to={sandboxDetailPath(r)}>{id}</Link>,
    },
    ...(isAdmin
      ? [
          {
            title: '租户',
            dataIndex: 'tenant',
            width: 128,
            ellipsis: true,
            onCell: () => consoleTagTableCellProps,
            render: (t: string) => <TenantTag tenant={t} />,
          },
        ]
      : []),
    sandboxLabelsColumn<SandboxHistoryItem>({ filteredValue: labelQuery }),
    {
      title: '状态',
      dataIndex: 'state',
      width: 124,
      ellipsis: true,
      onCell: () => consoleTagTableCellProps,
      render: (s) => <SandboxStateTag state={s} />,
    },
    {
      title: '生命周期时长',
      dataIndex: 'wallClockSeconds',
      width: 120,
      render: (v: number | undefined) => (v != null ? formatDuration(v) : '—'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 200,
      render: (v: string | undefined) => formatDateTime(v),
    },
    {
      title: '结束/删除',
      width: 200,
      render: (_, r) => formatDateTime(r.endedAt ?? r.deletedAt),
    },
    {
      title: '快照数',
      dataIndex: 'snapshotCount',
      width: 80,
      render: (n: number | undefined) => n ?? 0,
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, r) => <Link to={sandboxMonitorLogsPath(r)}>监控日志</Link>,
    },
  ];

  return (
    <div>
      <Typography.Title level={4}>申请历史</Typography.Title>
      <Typography.Paragraph type="secondary">
        启用：BFF 配置 <code>BFF_HISTORY_ENABLED=true</code> 且 <code>BFF_HISTORY_DATABASE_URL</code> 与 Server
        同库；SDK 直连创建也要入库时，在 Server 打开 <code>[store.lifecycle_audit] enabled = true</code>（需
        PostgreSQL）。
      </Typography.Paragraph>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap align="center">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索沙箱 ID"
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            style={{ width: 240 }}
          />
          {isAdmin && <AdminTenantSelect value={tenantFilter} onChange={syncTenantToUrl} width={220} />}
          <UsagePeriodFilterBar
            range={dayRange}
            onRangeChange={onPeriodRangeChange}
            allowAllTime
            includeRollingDays
            trailing={
              <Button type="primary" loading={recLoading} onClick={() => void loadRecommendations()}>
                计算沙箱推荐配置
              </Button>
            }
          />
        </Space>
        {periodActive ? (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            筛选区间（UTC，与列表及推荐计算同口径：生命周期与区间有重叠即计入）：{' '}
            <code>{periodFrom}</code> — <code>{periodTo}</code>
            {totalItems >= 0 ? ` · 共 ${totalItems} 条` : null}
            。计算在后台进行，具体推荐数据请到
            <Link to="/history/resource-recommendations">资源推荐</Link>
            查看。
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            未限定时间：列表展示全部历史；推荐计算默认使用最近 7 天滚动窗口。计算在后台进行，具体推荐数据请到
            <Link to="/history/resource-recommendations">资源推荐</Link>
            查看。
          </Typography.Text>
        )}
        {savedRunId && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message={
              <span>
                已开始计算。请到资源推荐查看具体推荐数据：{' '}
                <Link to={`/history/resource-recommendations/${savedRunId}`}>查看这条记录</Link>
                {' · '}
                <Link to="/history/resource-recommendations">资源推荐</Link>
              </span>
            }
          />
        )}
      </Card>

      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      {!periodActive && stats?.enabled && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="历史条数" value={stats.totalRecords ?? 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="仍活跃（未删/未终态）" value={stats.activeRecords ?? 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="累计运行时长" value={formatDuration(stats.totalWallClockSeconds ?? 0)} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title="平均运行时长" value={formatDuration(stats.avgWallClockSeconds ?? 0)} />
            </Card>
          </Col>
        </Row>
      )}
      <Table
        rowKey="sandboxId"
        loading={loading}
        columns={columns}
        dataSource={items}
        tableLayout="fixed"
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize: HISTORY_PAGE_SIZE,
          total: totalItems,
          hideOnSinglePage: false,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条，每页 ${HISTORY_PAGE_SIZE} 条`,
        }}
        onChange={(pag, filters, _sorter, extra) => {
          if (extra.action === 'filter') {
            const raw = filters.labels;
            const next = Array.isArray(raw) && raw[0] != null ? String(raw[0]).trim().slice(0, 200) : '';
            setLabelQuery(next);
            setPage(1);
            return;
          }
          if (extra.action === 'paginate') {
            setPage(pag.current ?? 1);
          }
        }}
      />
    </div>
  );
}
