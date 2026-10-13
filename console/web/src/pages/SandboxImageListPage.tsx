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

import { PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { imageCatalogApi } from '../api/client';
import type { SandboxImageCatalogInput, SandboxImageCatalogItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';

function PackageList({ items }: { items: string[] }) {
  if (items.length === 0) return <>—</>;
  return (
    <Space size={[4, 4]} wrap>
      {items.map((item) => (
        <Tag key={item} style={{ margin: 0 }}>
          {item}
        </Tag>
      ))}
    </Space>
  );
}

function TagSelect({ placeholder }: { placeholder: string }) {
  return (
    <Select
      mode="tags"
      tokenSeparators={[',', '，']}
      placeholder={placeholder}
      open={false}
      suffixIcon={null}
    />
  );
}

const EMPTY_FORM: SandboxImageCatalogInput = {
  displayName: '',
  imageUri: '',
  scenarios: [],
  systemPackages: [],
  runtimePackages: [],
  maintainer: '',
};

export function SandboxImageListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [form] = Form.useForm<SandboxImageCatalogInput>();
  const [items, setItems] = useState<SandboxImageCatalogItem[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SandboxImageCatalogItem | null>(null);

  const defaultMaintainer = user?.role === 'admin' ? '平台' : (user?.tenant ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await imageCatalogApi.list();
      setItems(data.items ?? []);
      setPersisted(data.persisted !== false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载镜像目录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        displayName: editing.displayName,
        imageUri: editing.imageUri,
        scenarios: editing.scenarios,
        systemPackages: editing.systemPackages,
        runtimePackages: editing.runtimePackages,
        maintainer: editing.maintainer,
      });
      return;
    }
    form.setFieldsValue({ ...EMPTY_FORM, maintainer: defaultMaintainer });
  }, [defaultMaintainer, editing, form, open]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      [
        item.displayName,
        item.imageUri,
        item.maintainer,
        ...item.scenarios,
        ...item.systemPackages,
        ...item.runtimePackages,
      ]
        .join('\n')
        .toLowerCase()
        .includes(query),
    );
  }, [items, keyword]);

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (row: SandboxImageCatalogItem) => {
    setEditing(row);
    setOpen(true);
  };

  const onSubmit = async () => {
    let values: SandboxImageCatalogInput;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await imageCatalogApi.update(editing.id, values);
        message.success('已更新镜像');
      } else {
        await imageCatalogApi.create(values);
        message.success('已录入镜像');
      }
      setOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (row: SandboxImageCatalogItem) => {
    try {
      await imageCatalogApi.remove(row.id);
      message.success('已删除');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<SandboxImageCatalogItem> = [
      {
        title: '名称',
        dataIndex: 'displayName',
        width: 180,
        fixed: 'left',
      },
      {
        title: '镜像地址',
        dataIndex: 'imageUri',
        ellipsis: true,
        render: (uri: string) => (
          <Typography.Text copyable={{ text: uri }} style={{ fontSize: 13 }}>
            {uri}
          </Typography.Text>
        ),
      },
      {
        title: '使用场景',
        dataIndex: 'scenarios',
        width: 220,
        render: (scenarios: string[]) => (
          <Space size={[4, 4]} wrap>
            {scenarios.map((item) => (
              <Tag key={item} color="blue" style={{ margin: 0 }}>
                {item}
              </Tag>
            ))}
          </Space>
        ),
      },
      {
        title: '系统包',
        dataIndex: 'systemPackages',
        width: 220,
        render: (packages: string[]) => <PackageList items={packages} />,
      },
      {
        title: '内置软件 / 语言生态',
        dataIndex: 'runtimePackages',
        width: 240,
        render: (packages: string[]) => <PackageList items={packages} />,
      },
      {
        title: '来源',
        dataIndex: 'maintainer',
        width: 120,
      },
      {
        title: '更新时间',
        dataIndex: 'updatedAt',
        width: 180,
        render: (value?: string) => formatDateTime(value),
      },
      {
        title: '操作',
        key: 'actions',
        width: 200,
        fixed: 'right',
        render: (_value, row) => (
          <Space size="small">
            <Button
              type="link"
              size="small"
              onClick={() => navigate(`/sandboxes/new?image=${encodeURIComponent(row.imageUri)}`)}
            >
              创建沙箱
            </Button>
            <Button type="link" size="small" disabled={!persisted} onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Popconfirm title="删除这张镜像？" description="已创建的沙箱不受影响。" onConfirm={() => onDelete(row)}>
              <Button type="link" size="small" danger disabled={!persisted}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
        <div>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            沙箱镜像列表
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            录入平台共用的沙箱基础镜像。各租户研发创建沙箱时可以从这里选用，镜像地址可直接复制。
          </Typography.Paragraph>
        </div>
        <Button type="primary" icon={<PlusOutlined />} disabled={!persisted} onClick={openCreate}>
          录入镜像
        </Button>
      </div>

      {!persisted && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="目录只读"
          description="启用 BFF 历史库，或配置 BFF_IMAGE_CATALOG_PATH 后，才能录入镜像。"
        />
      )}

      <Input.Search
        allowClear
        placeholder="搜索名称、镜像地址、场景或软件包"
        style={{ maxWidth: 420, marginBottom: 16 }}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
      />

      <Table<SandboxImageCatalogItem>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 1480 }}
        locale={{ emptyText: persisted ? '还没有镜像。点击右上角录入，供研发选用。' : '目录为空' }}
      />

      <Modal
        title={editing ? '编辑镜像' : '录入镜像'}
        open={open}
        confirmLoading={saving}
        onOk={() => void onSubmit()}
        onCancel={() => setOpen(false)}
        okText="保存"
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="displayName"
            label="名称"
            rules={[{ required: true, whitespace: true, message: '请填写名称' }]}
          >
            <Input placeholder="Python 3.12 沙箱" maxLength={80} />
          </Form.Item>
          <Form.Item
            name="imageUri"
            label="镜像地址"
            rules={[{ required: true, whitespace: true, message: '请填写镜像地址' }]}
          >
            <Input placeholder="hub.example.com/opensandbox/python:3.12" maxLength={512} />
          </Form.Item>
          <Form.Item name="scenarios" label="使用场景" extra="输入后回车，或用逗号分隔。">
            <TagSelect placeholder="数据分析、Agent 工具调用" />
          </Form.Item>
          <Form.Item name="systemPackages" label="系统包">
            <TagSelect placeholder="git、curl、build-essential" />
          </Form.Item>
          <Form.Item name="runtimePackages" label="内置软件 / 语言生态">
            <TagSelect placeholder="Python 3.12、pip、uv" />
          </Form.Item>
          <Form.Item name="maintainer" label="来源" extra="默认是当前登录身份，可改成团队或平台名称。">
            <Input placeholder={defaultMaintainer || '平台'} maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
