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

import { Alert, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';

/** 演示数据；后续由 BFF / 镜像 catalog API 替换 */
type SandboxImageCatalogRow = {
  key: string;
  displayName: string;
  imageUri: string;
  scenarios: string[];
  systemPackages: string[];
  runtimePackages: string[];
  maintainer: string;
};

const MOCK_CATALOG: SandboxImageCatalogRow[] = [
  {
    key: 'python-312',
    displayName: 'Python 3.12 沙箱',
    imageUri: 'registry.example.com/opensandbox/python:3.12-slim',
    scenarios: ['数据分析脚本', 'Agent 工具调用', 'Jupyter 类交互'],
    systemPackages: ['git', 'curl', 'ca-certificates', 'build-essential'],
    runtimePackages: ['Python 3.12', 'pip', 'uv（规划）'],
    maintainer: '平台内置',
  },
  {
    key: 'node-22',
    displayName: 'Node.js 22 沙箱',
    imageUri: 'registry.example.com/opensandbox/node:22-bookworm',
    scenarios: ['前端构建', 'npm 脚本自动化', '轻量 API 服务'],
    systemPackages: ['git', 'curl', 'openssl', 'python3-minimal'],
    runtimePackages: ['Node.js 22', 'npm', 'pnpm（可选）'],
    maintainer: '平台内置',
  },
  {
    key: 'code-interpreter',
    displayName: 'Code Interpreter 通用',
    imageUri: 'registry.example.com/opensandbox/code-interpreter:latest',
    scenarios: ['多语言 REPL', '代码评测', '教学演示'],
    systemPackages: ['bash', 'git', 'jq', 'ffmpeg（精简）'],
    runtimePackages: ['Python 3.11', 'Node 20', '常用科学计算库（预装示例）'],
    maintainer: '平台内置',
  },
  {
    key: 'custom-tenant',
    displayName: '租户自定义镜像（示例）',
    imageUri: 'registry.example.com/tenant-acme/sandbox-custom:v1',
    scenarios: ['企业内网依赖', '私有 CLI 工具链'],
    systemPackages: ['按 Dockerfile 构建'],
    runtimePackages: ['按 Dockerfile 构建'],
    maintainer: '租户 ACME（示例）',
  },
];

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

export function SandboxImageListPage() {
  const columns: ColumnsType<SandboxImageCatalogRow> = useMemo(
    () => [
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
            {scenarios.map((s) => (
              <Tag key={s} color="blue" style={{ margin: 0 }}>
                {s}
              </Tag>
            ))}
          </Space>
        ),
      },
      {
        title: '系统包',
        dataIndex: 'systemPackages',
        width: 240,
        render: (items: string[]) => <PackageList items={items} />,
      },
      {
        title: '内置软件 / 语言生态',
        dataIndex: 'runtimePackages',
        width: 240,
        render: (items: string[]) => <PackageList items={items} />,
      },
      {
        title: '来源',
        dataIndex: 'maintainer',
        width: 120,
      },
    ],
    [],
  );

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        沙箱镜像列表
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        平台与租户可用的沙箱基础镜像目录，包含推荐使用场景及预装环境说明。
      </Typography.Paragraph>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="功能开发中"
        description="当前为前端演示数据，尚未对接镜像 catalog 与真实包清单扫描。"
      />

      <Table<SandboxImageCatalogRow>
        rowKey="key"
        columns={columns}
        dataSource={MOCK_CATALOG}
        pagination={false}
        scroll={{ x: 1200 }}
      />
    </div>
  );
}
