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

import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { historyApi } from '../api/client';
import type {
  ResourceRecommendationRunDetail,
  ResourceRecommendationRunSummary,
} from '../api/types';
import { AdminTenantSelect, ALL_TENANTS, tenantFilterToQuery } from '../components/AdminTenantSelect';
import { TenantTag } from '../components/SemanticTags';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 20;

function RecommendationResultCard({ result }: { result: ResourceRecommendationRunDetail['result'] }) {
  if (!result?.requests || !result.limits) {
    return (
      <Alert type="warning" message="该记录无有效推荐结果（可能计算时数据不足）。" showIcon />
    );
  }
  return (
    <>
      <Row gutter={16}>
        <Col xs={12} sm={6}>
          <Statistic title="requests CPU" value={result.requests.cpu ?? '—'} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="limits CPU" value={result.limits.cpu ?? '—'} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="requests 内存" value={result.requests.memory ?? '—'} />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic title="limits 内存" value={result.limits.memory ?? '—'} />
        </Col>
      </Row>
      {result.sampleCount && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          推荐样本：CPU {result.sampleCount.cpu ?? 0} · 内存 {result.sampleCount.memory ?? 0} · 沙箱{' '}
          {result.sandboxCountWithMetrics ?? 0}/{result.sandboxCount ?? 0} · P{result.percentile ?? 95}
          {result.aggregation ? ` · ${result.aggregation}` : null}
        </Typography.Text>
      )}
      {(result.excludedSandboxes?.length ?? 0) > 0 && (
        <Table
          style={{ marginTop: 16 }}
          size="small"
          pagination={false}
          rowKey="sandboxId"
          dataSource={result.excludedSandboxes}
          columns={[
            { title: '沙箱 ID', dataIndex: 'sandboxId', ellipsis: true },
            { title: '原因', dataIndex: 'reason', ellipsis: true },
          ]}
        />
      )}
    </>
  );
}

function RunConditions({ run }: { run: ResourceRecommendationRunSummary }) {
  const periodLabel =
    run.windowLabel ||
    (run.period?.from && run.period?.to ? `${run.period.from} — ${run.period.to}` : '—');
  return (
    <Typography.Text type="secondary">
      统计区间：{run.windowLabel ? `最近 ${run.windowLabel}` : <code>{periodLabel}</code>}
      {run.label ? ` · 标签 ${run.label}` : ''}
      {run.sandboxIdFilter ? ` · 沙箱 ID ${run.sandboxIdFilter}` : ''}
      {run.tenant ? (
        <>
          {' '}
          · 租户 <TenantTag tenant={run.tenant} />
        </>
      ) : null}
    </Typography.Text>
  );
}

function RecommendationRunDetail({ runId }: { runId: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [loading, setLoading] = useState(true);
  const [run, setRun] = useState<ResourceRecommendationRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await historyApi.getResourceRecommendationRun(runId);
        if (!cancelled) setRun(data);
      } catch (e) {
        if (!cancelled) {
          setRun(null);
          setError(e instanceof Error ? e.message : '加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loading) {
    return <Card loading />;
  }
  if (error || !run) {
    return <Alert type="error" message={error ?? '记录不存在'} showIcon />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="计算条件">
        <RunConditions run={run} />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          创建于 {formatDateTime(run.createdAt)} · {run.createdByRole === 'admin' ? '管理员' : '租户'}{' '}
          {run.createdByActor ? `(${run.createdByActor})` : ''}
        </Typography.Text>
      </Card>
      <Card size="small" title="推荐结果">
        <RecommendationResultCard result={run.result} />
      </Card>
      {!isAdmin && (
        <Typography.Paragraph type="secondary">
          在<Link to="/history/sandboxes">申请历史</Link>使用相同筛选后点击「计算沙箱推荐配置」可生成新记录。
        </Typography.Paragraph>
      )}
    </Space>
  );
}

export function SandboxResourceRecommendationPage() {
  const { runId } = useParams<{ runId?: string }>();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ResourceRecommendationRunSummary[]>([]);
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tenantFilter, setTenantFilter] = useState(ALL_TENANTS);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tenant = isAdmin ? tenantFilterToQuery(tenantFilter) : undefined;
      const resp = await historyApi.listResourceRecommendationRuns({
        page,
        pageSize: PAGE_SIZE,
        ...(tenant ? { tenant } : {}),
      });
      setItems(resp.items ?? []);
      setTotalItems(resp.pagination?.totalItems ?? 0);
    } catch (e) {
      setItems([]);
      setTotalItems(0);
      setError(e instanceof Error ? e.message : '加载记录失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, page, tenantFilter]);

  useEffect(() => {
    if (runId) return;
    void loadList();
  }, [loadList, runId]);

  const columns: ColumnsType<ResourceRecommendationRunSummary> = useMemo(
    () => [
      {
        title: '创建时间',
        dataIndex: 'createdAt',
        width: 200,
        render: (v: string | undefined) => formatDateTime(v),
      },
      ...(isAdmin
        ? [
            {
              title: '租户',
              dataIndex: 'tenant',
              width: 128,
              render: (t: string | null | undefined) => (t ? <TenantTag tenant={t} /> : '全部'),
            },
          ]
        : []),
      {
        title: '区间 / 窗口',
        key: 'period',
        width: 220,
        ellipsis: true,
        render: (_, r) =>
          r.windowLabel ? `最近 ${r.windowLabel}` : `${r.period?.from ?? '—'} — ${r.period?.to ?? '—'}`,
      },
      {
        title: '筛选',
        key: 'filters',
        ellipsis: true,
        render: (_, r) => {
          const parts: string[] = [];
          if (r.label) parts.push(`标签=${r.label}`);
          if (r.sandboxIdFilter) parts.push(`ID=${r.sandboxIdFilter}`);
          return parts.length ? parts.join(' · ') : '—';
        },
      },
      {
        title: 'requests CPU / 内存',
        key: 'requests',
        width: 180,
        render: (_, r) => `${r.requests?.cpu ?? '—'} / ${r.requests?.memory ?? '—'}`,
      },
      {
        title: '操作',
        key: 'actions',
        width: 88,
        render: (_, r) => <Link to={`/history/resource-recommendations/${r.id}`}>详情</Link>,
      },
    ],
    [isAdmin],
  );

  if (runId) {
    return (
      <div>
        <Space style={{ marginBottom: 16 }}>
          <Button type="link" style={{ padding: 0 }}>
            <Link to="/history/resource-recommendations">← 返回列表</Link>
          </Button>
        </Space>
        <Typography.Title level={4}>资源推荐 · 记录详情</Typography.Title>
        <RecommendationRunDetail runId={runId} />
      </div>
    );
  }

  return (
    <div>
      <Typography.Title level={4}>资源推荐</Typography.Title>
      <Typography.Paragraph type="secondary">
        每次在<Link to="/history/sandboxes">申请历史</Link>点击「计算沙箱推荐配置」会在此保存一条记录（含筛选条件与完整结果）。
        Prometheus 与 PromQL 在<Link to="/platform/settings">系统设置 → 资源推荐</Link>中配置。
      </Typography.Paragraph>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          {isAdmin && (
            <AdminTenantSelect
              value={tenantFilter}
              onChange={(v) => {
                setTenantFilter(v);
                setPage(1);
              }}
              width={220}
            />
          )}
          <Button onClick={() => void loadList()} loading={loading}>
            刷新
          </Button>
          <Link to="/history/sandboxes">去申请历史计算 →</Link>
        </Space>
      </Card>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: totalItems,
          showSizeChanger: false,
          onChange: (p) => setPage(p),
        }}
      />
    </div>
  );
}
