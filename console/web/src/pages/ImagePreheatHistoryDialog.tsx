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

import { Alert, Modal, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useRef, useState } from 'react';

import { imageCatalogApi } from '../api/client';
import type { PreheatHistoryItem, SandboxImageCatalogItem } from '../api/types';
import { formatDateTime } from '../utils/format';

const STATE_LABEL: Record<PreheatHistoryItem['state'], { text: string; color: string }> = {
  pulling: { text: '拉取中', color: 'processing' },
  succeeded: { text: '成功', color: 'success' },
  failed: { text: '失败', color: 'error' },
};

export function ImagePreheatHistoryDialog({
  image,
  open,
  onClose,
}: {
  image: SandboxImageCatalogItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<PreheatHistoryItem[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [loading, setLoading] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!open || !image) return;
    let stopped = false;
    let inFlight = false;
    const load = async (quiet: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!quiet) setLoading(true);
      try {
        const data = await imageCatalogApi.preheatHistory(image.id);
        if (stopped) return;
        setPersisted(data.persisted !== false);
        setItems(data.items ?? []);
      } catch (error) {
        if (!quiet && !stopped) message.error(error instanceof Error ? error.message : '加载预热历史失败');
      } finally {
        inFlight = false;
        if (!quiet && !stopped) setLoading(false);
      }
    };
    void load(false);
    const timer = window.setInterval(() => {
      if (itemsRef.current.some((item) => item.state === 'pulling')) void load(true);
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, image]);

  const columns: ColumnsType<PreheatHistoryItem> = [
    { title: '开始时间', dataIndex: 'createdAt', width: 180, render: (value?: string) => formatDateTime(value) },
    { title: '租户', dataIndex: 'tenant', width: 120 },
    { title: '节点', dataIndex: 'nodeName' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (state: PreheatHistoryItem['state']) => {
        const label = STATE_LABEL[state];
        return <Tag color={label.color}>{label.text}</Tag>;
      },
    },
    { title: '说明', dataIndex: 'message', render: (value?: string) => value || '—' },
  ];

  return (
    <Modal
      title={image ? `预热历史 · ${image.displayName}` : '预热历史'}
      open={open}
      width={860}
      footer={null}
      onCancel={onClose}
      destroyOnClose
    >
      {!persisted && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="预热历史不可用"
          description="启用 BFF 历史库后，才能查看节点预热是否成功。"
        />
      )}
      <Table<PreheatHistoryItem>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: persisted ? '还没有预热记录' : '历史库未启用' }}
      />
    </Modal>
  );
}
