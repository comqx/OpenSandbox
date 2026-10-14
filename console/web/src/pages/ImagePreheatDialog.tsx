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

import { Alert, Modal, Select, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';

import { adminApi, imageCatalogApi } from '../api/client';
import type { PreheatNodeStatus, SandboxImageCatalogItem } from '../api/types';
import { mergePreheatProgress, preheatFinished } from '../utils/imagePreheat';

const STATE_LABEL: Record<PreheatNodeStatus['state'], { text: string; color: string }> = {
  pulling: { text: '拉取中', color: 'processing' },
  succeeded: { text: '成功', color: 'success' },
  failed: { text: '失败', color: 'error' },
};

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
  const [rows, setRows] = useState<PreheatNodeStatus[]>([]);
  const [preheatId, setPreheatId] = useState<string | null>(null);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const running = Boolean(preheatId) && !preheatFinished(rows);
  const finished = preheatFinished(rows);

  const loadNodes = useCallback(
    async (tenantName?: string) => {
      if (!image) return;
      setLoadingNodes(true);
      setLoadError(null);
      try {
        const data = await imageCatalogApi.preheatNodes(image.id, tenantName);
        setNodeOptions(data.nodes ?? []);
        setSelected([]);
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
    setPreheatId(null);
    setRows([]);
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

  useEffect(() => {
    if (!open || !preheatId || finished) return;
    let stopped = false;
    let reported = false;
    const tick = async () => {
      try {
        const status = await imageCatalogApi.preheatStatus(preheatId, isAdmin ? tenant : undefined);
        if (!stopped) setRows((previous) => mergePreheatProgress(previous, status.nodes ?? []));
      } catch (error) {
        if (stopped || reported) return;
        reported = true;
        message.error(error instanceof Error ? error.message : '查询预热进度失败');
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, preheatId, finished, isAdmin, tenant]);

  const start = async () => {
    if (!image) return;
    setStarting(true);
    try {
      const status = await imageCatalogApi.startPreheat(image.id, selected, isAdmin ? tenant : undefined);
      setPreheatId(status.preheatId);
      setRows(status.nodes ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发起预热失败');
    } finally {
      setStarting(false);
    }
  };

  const columns: ColumnsType<PreheatNodeStatus> = [
    { title: '节点', dataIndex: 'nodeName' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (state: PreheatNodeStatus['state']) => {
        const label = STATE_LABEL[state];
        return <Tag color={label.color}>{label.text}</Tag>;
      },
    },
    { title: '说明', dataIndex: 'message', render: (value?: string) => value || '—' },
  ];

  return (
    <Modal
      title={image ? `节点预热 · ${image.displayName}` : '节点预热'}
      open={open}
      width={720}
      maskClosable={false}
      closable={!running}
      onCancel={() => {
        if (!running) onClose();
      }}
      okText={finished ? '完成' : '开始预热'}
      cancelText="取消"
      confirmLoading={starting}
      okButtonProps={{ disabled: running || (!finished && selected.length === 0) }}
      cancelButtonProps={{ disabled: running, style: finished ? { display: 'none' } : undefined }}
      onOk={() => {
        if (finished) onClose();
        else void start();
      }}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        把这张镜像拉到勾选的节点上。拉完这次任务就结束，镜像留在节点的容器运行时里，不会创建沙箱。
        {image ? ` ${image.imageUri}` : ''}
      </Typography.Paragraph>
      {isAdmin && (
        <Select
          showSearch
          placeholder="选择租户"
          style={{ width: '100%', marginBottom: 12 }}
          disabled={Boolean(preheatId)}
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
      {preheatId ? (
        <Table<PreheatNodeStatus>
          rowKey="nodeName"
          size="small"
          pagination={false}
          columns={columns}
          dataSource={rows}
        />
      ) : (
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
      )}
    </Modal>
  );
}
