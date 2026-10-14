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
import { Alert, Button, Input, Modal, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { imageCatalogApi } from '../api/client';
import type { SandboxImageCatalogItem } from '../api/types';
import { ImagePreheatDialog } from './ImagePreheatDialog';
import { useAuth } from '../auth/AuthContext';
import { YamlCodeEditor } from '../components/YamlCodeEditor';
import { formatDateTime } from '../utils/format';
import { imageCatalogYamlTemplate, parseImageCatalogYaml } from '../utils/imageCatalogYaml';

function PackageList({ items, color }: { items?: string[]; color: string }) {
  const list = items ?? [];
  if (list.length === 0) return <>—</>;
  return (
    <Space size={[4, 4]} wrap>
      {list.map((item) => (
        <Tag key={item} color={color} style={{ margin: 0 }}>
          {item}
        </Tag>
      ))}
    </Space>
  );
}

export function SandboxImageListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<SandboxImageCatalogItem[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SandboxImageCatalogItem | null>(null);
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [preheatImage, setPreheatImage] = useState<SandboxImageCatalogItem | null>(null);

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
    setYamlError(null);
    setYamlText(imageCatalogYamlTemplate({ maintainer: defaultMaintainer }));
    setOpen(true);
  };

  const openEdit = (row: SandboxImageCatalogItem) => {
    setEditing(row);
    setYamlError(null);
    setYamlText(imageCatalogYamlTemplate(row));
    setOpen(true);
  };

  const onSubmit = async () => {
    let values;
    try {
      values = parseImageCatalogYaml(yamlText);
      setYamlError(null);
    } catch (error) {
      setYamlError(error instanceof Error ? error.message : 'YAML 无法解析');
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
        width: 160,
      },
      {
        title: '镜像地址',
        dataIndex: 'imageUri',
        onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
        render: (uri: string) => (
          <Typography.Text copyable={{ text: uri }} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            {uri}
          </Typography.Text>
        ),
      },
      {
        title: '使用场景',
        dataIndex: 'scenarios',
        width: 240,
        render: (scenarios?: string[]) => <PackageList items={scenarios} color="blue" />,
      },
      {
        title: '系统包',
        dataIndex: 'systemPackages',
        width: 240,
        render: (packages?: string[]) => <PackageList items={packages} color="orange" />,
      },
      {
        title: '内置软件 / 语言生态',
        dataIndex: 'runtimePackages',
        width: 260,
        render: (packages?: string[]) => <PackageList items={packages} color="green" />,
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
        width: 280,
        render: (_value, row) => (
          <Space size="small">
            <Button type="link" size="small" onClick={() => setPreheatImage(row)}>
              节点预热
            </Button>
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
        scroll={{ x: 'max-content' }}
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
        width={760}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          字段已经写好。只改冒号后面的值，绿色斜体的备注可以保留。
        </Typography.Paragraph>
        {yamlError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={yamlError} />
        )}
        <YamlCodeEditor value={yamlText} onChange={setYamlText} />
      </Modal>
      <ImagePreheatDialog
        image={preheatImage}
        open={preheatImage !== null}
        isAdmin={user?.role === 'admin'}
        onClose={() => setPreheatImage(null)}
      />
    </div>
  );
}
