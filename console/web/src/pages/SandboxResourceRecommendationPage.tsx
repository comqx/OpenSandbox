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

import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tooltip, Typography } from 'antd';
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

const EXCLUSION_REASON_LABELS: Record<string, string> = {
  no_metrics_in_window: 'Pod 有监控序列，但在该沙箱有效运行时段内没有 CPU/内存样本。',
  pod_name_unresolved: '未找到 <沙箱ID>-0 或 sandbox-<沙箱ID>-0 的监控序列。Pool、agent-sandbox、Docker 不在这次推荐范围内。',
  partial_metrics: 'CPU 与内存没有同时达到至少 3 个样本，未计入推荐。',
  prometheus_error: '拉取该沙箱所在批次监控时 Prometheus 请求失败（网络、超时或查询错误）。',
};

const WARNING_LABELS: Record<string, string> = {
  headroom_defaults_applied: '这套设置还没按新口径保存过，峰值余量使用默认的 CPU 1.2 和内存 1.15，没有沿用旧的 limits 倍数。',
  heterogeneous_cohort: '这批沙箱的内存峰值相差很大（p95 / p50 大于 3）。当前规格按高分位给出，按 label 或镜像拆开再算更合适。',
  cpu_peak_fallback: '部分沙箱没有 1 分钟 CPU 峰值序列，这些沙箱的 CPU limit 退回到 2 分钟均值的最大值。',
};

function formatCores(value?: number): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (value >= 1) return `${Number(value.toFixed(2))} 核`;
  return `${Math.ceil(value * 1000)}m`;
}

function formatBytes(value?: number): string {
  if (value == null || Number.isNaN(value)) return '—';
  const mib = value / 1024 / 1024;
  if (mib >= 1024) return `${Number((mib / 1024).toFixed(2))}Gi`;
  return `${Math.ceil(mib)}Mi`;
}

function exclusionReasonLabel(code: string): string {
  return EXCLUSION_REASON_LABELS[code] ?? code;
}

function sandboxDetailPath(sandboxId: string, tenant: string | null | undefined, isAdmin: boolean): string {
  if (isAdmin && tenant) {
    return `/sandboxes/${encodeURIComponent(sandboxId)}?tenant=${encodeURIComponent(tenant)}`;
  }
  return `/sandboxes/${encodeURIComponent(sandboxId)}`;
}

function RecommendationResultCard({
  result,
  tenant,
  isAdmin,
}: {
  result: ResourceRecommendationRunDetail['result'];
  tenant?: string | null;
  isAdmin: boolean;
}) {
  if (!result?.requests || !result.limits) {
    return (
      <Alert type="warning" message="该记录无有效推荐结果（可能计算时数据不足）。" showIcon />
    );
  }
  const excludedSandboxes = result.excludedSandboxes ?? [];
  const warnings = result.warnings ?? [];
  const distribution = result.distribution;
  const distributionRows = distribution
    ? [
        { key: 'cpuRequest', label: '各沙箱 CPU 持续用量（箱内 p75）', point: distribution.cpuRequestCores, format: formatCores },
        { key: 'memRequest', label: '各沙箱内存持续用量（箱内 p95）', point: distribution.memoryRequestBytes, format: formatBytes },
        { key: 'cpuPeak', label: '各沙箱 CPU 峰值', point: distribution.cpuPeakCores, format: formatCores },
        { key: 'memPeak', label: '各沙箱内存峰值', point: distribution.memoryPeakBytes, format: formatBytes },
      ]
    : [];
  return (
    <>
      {result.aggregation === 'pooled_percentile' && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="这条记录使用旧的时间加权混合分位，长寿命沙箱占的权重更大。"
        />
      )}
      {result.confidence === 'low' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="合格沙箱少于 20 个，这次推荐的稳定性较低。"
        />
      )}
      {warnings.map((code) => (
        <Alert
          key={code}
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={WARNING_LABELS[code] ?? code}
        />
      ))}
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
          样本：CPU {result.sampleCount.cpu ?? 0} · 内存 {result.sampleCount.memory ?? 0} · 合格沙箱{' '}
          {result.sandboxCountWithMetrics ?? 0}/{result.sandboxCount ?? 0}
          {result.aggregation === 'per_sandbox_percentile' ? ' · 每个沙箱一票' : null}
          {result.confidence === 'low' ? ' · 样本偏少' : null}
          {result.confidence === 'ok' ? ' · 样本充足' : null}
        </Typography.Text>
      )}
      {result.aggregation === 'per_sandbox_percentile' && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          上面的 CPU request 是各沙箱持续用量的沙箱间 p75。内存 request 和两项 limit 用沙箱间 P
          {result.percentile ?? 95}。下表是这些沙箱统计量的分布，表里的 p95 不是 CPU request。
        </Typography.Text>
      )}
      {distributionRows.length > 0 && (
        <Table
          style={{ marginTop: 16 }}
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={distributionRows}
          columns={[
            { title: '沙箱间分布', dataIndex: 'label' },
            {
              title: 'p50',
              render: (_, row) => row.format(row.point?.p50),
            },
            {
              title: 'p95',
              render: (_, row) => row.format(row.point?.p95),
            },
            {
              title: 'max',
              render: (_, row) => row.format(row.point?.max),
            },
          ]}
        />
      )}
      {excludedSandboxes.length > 0 && (
        <>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 16 }}>
            以下 {excludedSandboxes.length} 个沙箱未计入推荐：
          </Typography.Text>
          <Table
            style={{ marginTop: 8 }}
            size="small"
            pagination={excludedSandboxes.length > 10 ? { pageSize: 10, size: 'small' } : false}
            rowKey="sandboxId"
            dataSource={excludedSandboxes}
            columns={[
              {
                title: '沙箱 ID',
                dataIndex: 'sandboxId',
                ellipsis: true,
                render: (id: string) => (
                  <Link to={sandboxDetailPath(id, tenant, isAdmin)}>{id}</Link>
                ),
              },
              {
                title: '说明',
                dataIndex: 'reason',
                render: (code: string) => (
                  <Tooltip title={`内部代码：${code}`}>
                    <span>{exclusionReasonLabel(code)}</span>
                  </Tooltip>
                ),
              },
            ]}
          />
        </>
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
        <RecommendationResultCard result={run.result} tenant={run.tenant} isAdmin={isAdmin} />
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
        width: 200,
        render: (_, r) => {
          if (r.windowLabel) {
            return `最近 ${r.windowLabel}`;
          }
          return (
            <div style={{ whiteSpace: 'normal', lineHeight: 1.45 }}>
              <div>
                <Typography.Text type="secondary">起 </Typography.Text>
                {formatDateTime(r.period?.from)}
              </div>
              <div>
                <Typography.Text type="secondary">止 </Typography.Text>
                {formatDateTime(r.period?.to)}
              </div>
            </div>
          );
        },
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
