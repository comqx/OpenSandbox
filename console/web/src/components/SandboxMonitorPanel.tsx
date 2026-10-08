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

import { Alert, Button, Card, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { adminApi, monitorApi } from '../api/client';
import type { SandboxMonitorResponse } from '../api/types';
import { formatDateTime } from '../utils/format';

type Props = {
  sandboxId: string;
  tenant?: string;
};

export function SandboxMonitorPanel({ sandboxId, tenant }: Props) {
  const [data, setData] = useState<SandboxMonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp =
        tenant != null && tenant !== ''
          ? await adminApi.sandboxMonitor(sandboxId, tenant)
          : await monitorApi.getSandboxMonitor(sandboxId);
      setData(resp);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : '加载监控失败');
    } finally {
      setLoading(false);
    }
  }, [sandboxId, tenant]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card>
        <Spin tip="加载 Grafana 监控…" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Alert type="error" showIcon message={error} />
      </Card>
    );
  }

  if (!data?.enabled) {
    return (
      <Card>
        <Alert
          type="info"
          showIcon
          message={data?.message ?? 'Grafana 监控未配置'}
          description="Admin 可在「平台 → 系统设置」中配置 Grafana 地址与 Dashboard，或通过 BFF 环境变量注入默认值。"
        />
      </Card>
    );
  }

  const warnings = data.warnings ?? [];

  return (
    <Card
      title="沙箱监控（Grafana）"
      extra={<Button onClick={() => void load()}>刷新</Button>}
    >
      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="提示"
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          }
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        时间范围：
        {formatDateTime(data.timeRange?.from)} — {formatDateTime(data.timeRange?.to)}
        {data.namespace ? ` · namespace=${data.namespace}` : ''}
        {data.pods?.length ? ` · Pod: ${data.pods.map((p) => p.name).join(', ')}` : ''}
      </Typography.Paragraph>
      {data.iframeUrl ? (
        <iframe
          title="Grafana sandbox monitor"
          src={data.iframeUrl}
          style={{ width: '100%', height: 'min(72vh, 720px)', border: '1px solid #f0f0f0', borderRadius: 8 }}
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : (
        <Alert type="warning" showIcon message="无法生成嵌入地址" />
      )}
    </Card>
  );
}
