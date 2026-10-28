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

import { FilterOutlined } from '@ant-design/icons';
import { Button, Input, Popover, Space, Tag } from 'antd';
import type { ColumnType } from 'antd/es/table';
import type { FilterDropdownProps } from 'antd/es/table/interface';

import { labelTagColor } from '../utils/semanticTheme';
import { metadataMatchesLabelQuery } from '../utils/sandboxLabels';
import { consoleTagTableCellProps } from './SemanticTags';

type LabelRecord = { metadata?: Record<string, string> };

const VISIBLE_LABEL_COUNT = 3;

function LabelTag({ labelKey, value }: { labelKey: string; value: string }) {
  return (
    <Tag
      color={labelTagColor(labelKey)}
      className="console-semantic-tag console-label-tag"
      title={`${labelKey}=${value}`}
    >
      <span className="console-label-tag-key">{labelKey}</span>
      <span className="console-label-tag-eq">=</span>
      <span>{value}</span>
    </Tag>
  );
}

export function SandboxLabelTags({ metadata }: { metadata?: Record<string, string> }) {
  const entries = Object.entries(metadata ?? {}).filter(([key, value]) => key && value != null && value !== '');
  if (!entries.length) return <>—</>;
  const visible = entries.slice(0, VISIBLE_LABEL_COUNT);
  const hiddenCount = entries.length - visible.length;
  return (
    <Space size={[4, 4]} wrap>
      {visible.map(([key, value]) => (
        <LabelTag key={key} labelKey={key} value={value} />
      ))}
      {hiddenCount > 0 && (
        <Popover
          trigger="click"
          title="全部标签"
          content={
            <Space size={[4, 4]} wrap style={{ maxWidth: 420 }}>
              {entries.map(([key, value]) => (
                <LabelTag key={key} labelKey={key} value={value} />
              ))}
            </Space>
          }
        >
          <Tag className="console-label-more">显示更多 +{hiddenCount}</Tag>
        </Popover>
      )}
    </Space>
  );
}

function LabelFilterDropdown({ setSelectedKeys, selectedKeys, confirm, clearFilters }: FilterDropdownProps) {
  const value = selectedKeys[0] != null ? String(selectedKeys[0]) : '';
  return (
    <div style={{ padding: 8, width: 220 }} onKeyDown={(event) => event.stopPropagation()}>
      <Input
        allowClear
        placeholder="键、值或 key=value"
        value={value}
        maxLength={200}
        onChange={(event) => {
          const next = event.target.value;
          setSelectedKeys(next ? [next] : []);
        }}
        onPressEnter={() => confirm()}
        style={{ marginBottom: 8 }}
      />
      <Space>
        <Button type="primary" size="small" onClick={() => confirm()}>
          筛选
        </Button>
        <Button
          size="small"
          onClick={() => {
            clearFilters?.();
            confirm({ closeDropdown: true });
          }}
        >
          重置
        </Button>
      </Space>
    </div>
  );
}

export function sandboxLabelsColumn<T extends LabelRecord>(options?: {
  filteredValue?: string;
}): ColumnType<T> {
  const controlled = options != null;
  return {
    title: '标签',
    key: 'labels',
    width: 220,
    onCell: () => consoleTagTableCellProps,
    filterDropdown: (props) => <LabelFilterDropdown {...props} />,
    filterIcon: (filtered) => <FilterOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
    ...(controlled
      ? { filteredValue: options.filteredValue ? [options.filteredValue] : null }
      : {
          onFilter: (value, record) => metadataMatchesLabelQuery(record.metadata, String(value ?? '')),
        }),
    render: (_, record) => <SandboxLabelTags metadata={record.metadata} />,
  };
}
