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

import { Alert, Button, Card, Form, Input, Select, Space, Switch, Typography, message } from 'antd';
import { useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { platformSettingsApi } from '../../api/client';
import type { PlatformGrafanaSettings } from '../../api/types';

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
      setSaving(true);
      const data = await platformSettingsApi.update(values);
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

  return (
    <div>
      <Typography.Title level={4}>系统设置</Typography.Title>
      <Typography.Paragraph type="secondary">
        配置 Grafana Dashboard 嵌入（iframe 使用 kiosk 模式：隐藏 Grafana 顶栏与用户区，保留变量与时间范围）。租户仅能在沙箱详情查看本 namespace 的监控；不在此存储 Grafana 登录密码。
      </Typography.Paragraph>

      {!meta.persisted && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="设置只读"
          description="启用 BFF_HISTORY_DATABASE_URL 或配置 BFF_PLATFORM_SETTINGS_PATH 后，Admin 方可在此保存覆盖项。"
        />
      )}

      <Card loading={loading} title="Grafana 监控">
        <Form form={form} layout="vertical" style={{ maxWidth: 640 }}>
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
          <Space>
            <Button type="primary" loading={saving} onClick={() => void onSave()}>
              保存
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
