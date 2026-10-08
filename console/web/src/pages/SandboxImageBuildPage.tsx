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

import { Alert, Card, Steps, Typography } from 'antd';

const WORKFLOW_STEPS = [
  {
    title: '编写 Dockerfile',
    description: '在控制台在线编辑沙箱基础镜像的 Dockerfile。',
    placeholder: 'Dockerfile 编辑器、语法高亮与模板将在此提供。',
  },
  {
    title: '远程构建',
    description: '提交后在集群内远程构建沙箱镜像，并展示构建日志与状态。',
    placeholder: '构建任务触发、进度与日志面板将在此提供。',
  },
  {
    title: '回传镜像管理',
    description: '构建成功后镜像写入平台沙箱镜像管理，供租户选用。',
    placeholder: '镜像列表、版本与推送结果将在此展示。',
  },
  {
    title: 'SDK 引用',
    description: '开发侧通过 OpenSandbox SDK 在创建沙箱时引用已发布的镜像。',
    placeholder: '与 Lifecycle / 镜像 catalog 的对接说明将在此提供。',
  },
] as const;

export function SandboxImageBuildPage() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        沙箱镜像制作
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        从 Dockerfile 到可引用沙箱镜像的完整流程。当前为功能占位，后续将对接远程构建与平台镜像管理。
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
        message="功能开发中"
        description="以下步骤为规划中的制作流程，交互与后端能力尚未接入。"
      />

      <Steps
        direction="vertical"
        current={0}
        items={WORKFLOW_STEPS.map((step) => ({
          title: step.title,
          description: step.description,
        }))}
        style={{ marginBottom: 24 }}
      />

      {WORKFLOW_STEPS.map((step, index) => (
        <Card
          key={step.title}
          title={`${index + 1}. ${step.title}`}
          style={{ marginBottom: 16 }}
          type="inner"
        >
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {step.placeholder}
          </Typography.Paragraph>
        </Card>
      ))}
    </div>
  );
}
