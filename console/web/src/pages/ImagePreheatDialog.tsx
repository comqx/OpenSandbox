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

import { Alert, Modal, Select, Table, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { adminApi, imageCatalogApi } from '../api/client';
import type { SandboxImageCatalogItem } from '../api/types';

export function ImagePreheatDialog({
  image,
  open,
  isAdmin,
  onClose,
}: {
  image: SandboxImageCatalogItem | null;
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [tenants, setTenants] = useState<{ name: string; namespace?: string }[]>([]);
  const [tenant, setTenant] = useState<string | undefined>();
  const [nodeOptions, setNodeOptions] = useState<{ name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadNodes = useCallback(
    async (tenantName?: string) => {
      if (!image) return;
      setLoadingNodes(true);
      setLoadError(null);
      setSelected([]);
      try {
        const data = await imageCatalogApi.preheatNodes(image.id, tenantName);
        setNodeOptions(data.nodes ?? []);
      } catch (error) {
        setNodeOptions([]);
        setLoadError(error instanceof Error ? error.message : '加载节点失败');
      } finally {
        setLoadingNodes(false);
      }
    },
    [image],
  );

  useEffect(() => {
    if (!open || !image) return;
    setTenant(undefined);
    setSelected([]);
    setNodeOptions([]);
    setLoadError(null);
    if (isAdmin) {
      void adminApi
        .listTenants()
        .then((data) => setTenants(data.items ?? []))
        .catch((error: unknown) => {
          setLoadError(error instanceof Error ? error.message : '加载租户失败');
        });
      return;
    }
    void loadNodes(undefined);
  }, [open, image, isAdmin, loadNodes]);

  const start = async () => {
    if (!image) return;
    setStarting(true);
    try {
      await imageCatalogApi.startPreheat(image.id, selected, isAdmin ? tenant : undefined);
      message.success('已开始预热，可在预热历史里查看结果');
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发起预热失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal
      title={image ? `节点预热 · ${image.displayName}` : '节点预热'}
      open={open}
      width={720}
      maskClosable={false}
      onCancel={onClose}
      okText="开始预热"
      cancelText="取消"
      confirmLoading={starting}
      okButtonProps={{ disabled: selected.length === 0 }}
      onOk={() => void start()}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        把这张镜像拉到勾选的节点上。提交后可以关掉窗口，到「预热历史」看每台节点是否成功。不会创建沙箱。
        {image ? ` ${image.imageUri}` : ''}
      </Typography.Paragraph>
      {isAdmin && (
        <Select
          showSearch
          placeholder="选择租户"
          style={{ width: '100%', marginBottom: 12 }}
          disabled={starting}
          value={tenant}
          options={tenants.map((item) => ({
            value: item.name,
            label: item.namespace ? `${item.name}（${item.namespace}）` : item.name,
          }))}
          onChange={(value: string) => {
            setTenant(value);
            void loadNodes(value);
          }}
        />
      )}
      {loadError && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadError} />}
      <Table<{ name: string }>
        rowKey="name"
        size="small"
        loading={loadingNodes}
        pagination={false}
        dataSource={nodeOptions}
        locale={{ emptyText: isAdmin && !tenant ? '先选择租户' : '没有可调度的节点' }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
        }}
        columns={[{ title: '节点', dataIndex: 'name' }]}
      />
    </Modal>
  );
}
