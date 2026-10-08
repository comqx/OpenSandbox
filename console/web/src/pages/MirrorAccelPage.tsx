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

import { Alert, Card, Space, Typography } from 'antd';

const PIP_MIRROR =
  'http://mirrorproxy-server.opensandbox-system.svc.cluster.local:3000/pypi/simple/';
const NPM_REGISTRY =
  'http://mirrorproxy-server.opensandbox-system.svc.cluster.local:3000/npm/';

const PIP_HINTS = [
  `pip install -i ${PIP_MIRROR} requests`,
  `export PIP_INDEX_URL=${PIP_MIRROR}`,
] as const;

const NPM_HINTS = [
  `npm install --registry=${NPM_REGISTRY} lodash`,
  `npm config set registry ${NPM_REGISTRY}`,
] as const;

type MirrorRowProps = {
  title: string;
  url: string;
  hints: readonly string[];
};

function MirrorRow({ title, url, hints }: MirrorRowProps) {
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <div style={{ marginTop: 8 }}>
        <Typography.Text copyable={{ text: url }} style={{ fontSize: 13, wordBreak: 'break-all' }}>
          {url}
        </Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
        示例命令（点击右侧复制）：
      </Typography.Text>
      <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 6 }}>
        {hints.map((command) => (
          <Typography.Text
            key={command}
            copyable={{ text: command }}
            code
            style={{ fontSize: 13, wordBreak: 'break-all' }}
          >
            {command}
          </Typography.Text>
        ))}
      </Space>
    </div>
  );
}

export function MirrorAccelPage() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        镜像加速
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        集群内 mirrorproxy 提供的依赖包加速地址，供沙箱 Pod 内安装 Python / Node 依赖时使用（地址仅在集群 Service
        网络内可达）。本页为环境说明，与「申请历史 / 镜像运行统计」等历史库无关；地址目前为前端静态配置，随集群部署约定。
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="集群内访问"
        description="上述 host 为 Kubernetes 集群 DNS（*.svc.cluster.local），请在沙箱或同集群工作负载内配置 pip / npm；本地开发机通常无法直接解析该地址。"
      />

      <Card title="依赖包加速">
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <MirrorRow title="pip（PyPI simple）" url={PIP_MIRROR} hints={PIP_HINTS} />
          <MirrorRow title="npm（registry）" url={NPM_REGISTRY} hints={NPM_HINTS} />
        </Space>
      </Card>
    </div>
  );
}
