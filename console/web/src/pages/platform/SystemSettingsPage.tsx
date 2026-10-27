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
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tabs,
  Typography,
  message,
} from 'antd';
import { useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { platformSettingsApi } from '../../api/client';
import type { PlatformGrafanaSettings } from '../../api/types';
import { platformSettingsSavePayload } from '../../utils/platformSettingsSave';

export function SystemSettingsPage() {
  const { user } = useAuth();
  const [form] = Form.useForm<PlatformGrafanaSettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<{ persisted?: boolean; source?: string }>({});

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const data = await platformSettingsApi.get();
        form.setFieldsValue(data);
        setMeta({ persisted: data.persisted, source: data.source });
      } catch (e) {
        message.error(e instanceof Error ? e.message : '加载设置失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [form]);

  const onSave = async () => {
    try {
      const values = await form.validateFields();
      const payload = platformSettingsSavePayload(values, form.getFieldsValue(true));
      setSaving(true);
      const data = await platformSettingsApi.update(payload);
      form.setFieldsValue(data);
      setMeta({ persisted: data.persisted, source: data.source });
      message.success('已保存');
    } catch (e) {
      if (e instanceof Error && e.message) {
        message.error(e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  if (user?.role !== 'admin') {
    return <Alert type="error" showIcon message="仅 Admin 可访问系统设置" />;
  }

  const tabItems = [
    {
      key: 'grafana',
      label: 'Grafana 监控',
      children: (
        <>
          <Typography.Paragraph type="secondary">
            沙箱详情页嵌入 Grafana Dashboard（kiosk 模式）。租户仅能看到本 namespace 监控；不在此存储 Grafana
            登录密码。
          </Typography.Paragraph>
          <Form.Item name="enabled" label="启用沙箱监控" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Grafana 根地址"
            rules={[{ required: true, message: '请输入 Grafana 地址' }]}
          >
            <Input placeholder="https://grafana-uop.example.com" />
          </Form.Item>
          <Form.Item
            name="dashboardSlug"
            label="Dashboard slug"
            rules={[{ required: true }]}
            extra="例如 opensandbox-pod-node"
          >
            <Input />
          </Form.Item>
          <Form.Item name="dashboardUid" label="Dashboard UID" rules={[{ required: true }]}>
            <Input placeholder="711161a" />
          </Form.Item>
          <Form.Item name="refresh" label="刷新间隔">
            <Input placeholder="30s" />
          </Form.Item>
          <Form.Item name="embedMode" label="嵌入模式">
            <Select
              options={[
                { value: 'direct', label: 'direct — iframe 直连 Grafana（内网匿名/已登录）' },
                { value: 'proxy', label: 'proxy — 经 BFF 反代 + Auth Proxy 头' },
              ]}
            />
          </Form.Item>
          <Typography.Text type="secondary">Dashboard 变量名（与 Grafana 模板一致）</Typography.Text>
          <Form.Item name="varNamespace" label="namespace 变量">
            <Input />
          </Form.Item>
          <Form.Item name="varPod" label="pod 变量">
            <Input />
          </Form.Item>
          <Form.Item name="varNode" label="node 变量">
            <Input />
          </Form.Item>
          <Form.Item
            name="datasourceUid"
            label="数据源 UID"
            extra="写入嵌入地址的 var-DS_PROM。留空时使用 prometheus。例如 cfzrpakzi1rlsd。"
          >
            <Input placeholder="prometheus" />
          </Form.Item>
          <Form.Item
            name="varDatasource"
            label="数据源变量名"
            extra="一般保持 var-DS_PROM。这里填的是 URL 参数名，不是数据源 UID。"
          >
            <Input placeholder="var-DS_PROM" />
          </Form.Item>
          <Form.Item name="authProxyEnabled" label="反代时发送 Auth Proxy 头" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="authProxyUserHeader" label="Auth Proxy 头名称">
            <Input placeholder="X-WEBAUTH-USER" />
          </Form.Item>
        </>
      ),
    },
    {
      key: 'recommendation',
      label: '资源推荐',
      forceRender: true,
      children: (
        <>
          <Typography.Paragraph type="secondary">
            每个沙箱先各自算出持续用量和峰值，沙箱之间等权取分位，生成主容器 sandbox 的 requests / limits。
            PromQL 须包含 <code>{'{{namespace}}'}</code>，以及 <code>{'{{pod_regex}}'}</code> 或{' '}
            <code>{'{{pod}}'}</code>（推荐 <code>pod=~&quot;{'{{pod_regex}}'}&quot;</code>，并限定{' '}
            <code>container=&quot;sandbox&quot;</code>
            ）。默认还会尝试升级前的 Pod 名 <code>sandbox-&lt;id&gt;-0</code>。CPU 沙箱间分位数用于 CPU
            limit，内存沙箱间分位数用于内存 request 和内存 limit。CPU request 固定取各沙箱 p75 的
            p75。峰值余量乘在对应峰值分位上，默认 CPU 1.2、内存 1.15。第一次保存会写成这组新余量，请求里带上的旧倍数不会写入。
          </Typography.Paragraph>
          <Form.Item name={['resourceRecommendation', 'enabled']} label="启用资源推荐" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name={['resourceRecommendation', 'prometheusUrl']} label="Prometheus 查询地址">
            <Input placeholder="http://prometheus.monitoring.svc:9090" />
          </Form.Item>
          <Form.Item
            name={['resourceRecommendation', 'memoryPromql']}
            label="内存 PromQL"
            extra="默认 sandbox 容器 working set（bytes）"
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            name={['resourceRecommendation', 'cpuPromql']}
            label="CPU 持续用量 PromQL"
            extra="默认 sandbox 容器 2 分钟 rate，用于 request"
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            name={['resourceRecommendation', 'cpuPeakPromql']}
            label="CPU 峰值 PromQL"
            extra="默认 sandbox 容器 1 分钟 rate，用于 limit"
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Space wrap size="large">
            <Form.Item
              name={['resourceRecommendation', 'cpuPercentile']}
              label="CPU 沙箱间分位数"
              extra="用于 CPU limit"
            >
              <InputNumber min={1} max={100} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item
              name={['resourceRecommendation', 'memoryPercentile']}
              label="内存沙箱间分位数"
              extra="用于内存 request 和内存 limit"
            >
              <InputNumber min={1} max={100} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Space wrap size="large">
            <Form.Item
              name={['resourceRecommendation', 'cpuLimitRatio']}
              label="CPU 峰值余量"
              extra="乘在 CPU 峰值分位上"
            >
              <InputNumber min={0.1} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name={['resourceRecommendation', 'cpuLimitFloor']} label="CPU limits 下限">
              <Input placeholder="100m" style={{ width: 120 }} />
            </Form.Item>
            <Form.Item
              name={['resourceRecommendation', 'memoryLimitRatio']}
              label="内存峰值余量"
              extra="乘在内存峰值分位上"
            >
              <InputNumber min={0.1} step={0.1} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name={['resourceRecommendation', 'memoryLimitFloor']} label="内存 limits 下限">
              <Input placeholder="200Mi" style={{ width: 120 }} />
            </Form.Item>
          </Space>
        </>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4}>系统设置</Typography.Title>

      {!meta.persisted && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="设置只读"
          description="启用 BFF_HISTORY_DATABASE_URL 或配置 BFF_PLATFORM_SETTINGS_PATH 后，Admin 方可在此保存覆盖项。"
        />
      )}

      <Card loading={loading}>
        <Form form={form} layout="vertical" style={{ maxWidth: 720 }}>
          <Tabs defaultActiveKey="grafana" items={tabItems} />
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" loading={saving} onClick={() => void onSave()}>
              保存全部设置
            </Button>
            {meta.source && (
              <Typography.Text type="secondary">持久化：{meta.source}</Typography.Text>
            )}
          </Space>
        </Form>
      </Card>
    </div>
  );
}
