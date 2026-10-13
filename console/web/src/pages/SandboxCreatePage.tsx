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

import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import type { CollapseProps } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { sandboxApi } from '../api/client';
import {
  buildSandboxCreateBody,
  type SandboxCreateFormValues,
  type SourceKind,
  type VolumeFields,
} from '../utils/sandboxCreatePayload';
import './SandboxCreatePage.css';

const SOURCE_HINT: Record<SourceKind, string> = {
  image: '从容器镜像启动。启动命令和资源上限会随请求提交。',
  snapshot: '从快照恢复。启动命令可留空，服务端默认执行 tail -f /dev/null。',
  template: '从已成功的 FSB 模板启动。工作负载由模板固定，这里提交模板 ID、超时、元数据、网络策略和扩展参数。',
  pool: '从预置资源池分配。镜像、启动命令、资源、环境变量、元数据和安全访问可按需填写。网络、平台、存储卷和生命周期沿用资源池。',
};

function allows(source: SourceKind, kinds: readonly SourceKind[]): boolean {
  return kinds.includes(source);
}

function ArgList({
  name,
  addLabel,
  rules,
}: {
  name: string | (string | number)[];
  addLabel: string;
  rules?: { validator: (_: unknown, value: { value?: string }[] | undefined) => Promise<void> }[];
}) {
  return (
    <Form.List name={name} rules={rules}>
      {(fields, { add, remove }, { errors }) => (
        <>
          {fields.map((field) => (
            <div className="create-arg-row" key={field.key}>
              <Form.Item name={[field.name, 'value']}>
                <Input placeholder="参数" />
              </Form.Item>
              <Button
                type="text"
                aria-label="删除参数"
                icon={<MinusCircleOutlined />}
                onClick={() => remove(field.name)}
              />
            </div>
          ))}
          <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
            {addLabel}
          </Button>
          <Form.ErrorList errors={errors} />
        </>
      )}
    </Form.List>
  );
}

function PairList({
  name,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  name: string | (string | number)[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <>
          {fields.map((field) => (
            <div className="create-pair-row" key={field.key}>
              <Form.Item name={[field.name, 'key']}>
                <Input placeholder={keyPlaceholder} />
              </Form.Item>
              <Form.Item name={[field.name, 'value']}>
                <Input placeholder={valuePlaceholder} />
              </Form.Item>
              <Button
                type="text"
                aria-label="删除此项"
                icon={<MinusCircleOutlined />}
                onClick={() => remove(field.name)}
              />
            </div>
          ))}
          <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
            {addLabel}
          </Button>
        </>
      )}
    </Form.List>
  );
}

function ResourceFields({
  name,
  requireCore,
}: {
  name: 'limits' | 'requests';
  requireCore: boolean;
}) {
  const cpuRule = requireCore
    ? [{ required: true, whitespace: true, message: '请填写 CPU' }]
    : undefined;
  const memoryRule = requireCore
    ? [{ required: true, whitespace: true, message: '请填写内存' }]
    : undefined;
  return (
    <>
      <div className="create-resource-grid">
        <Form.Item name={[name, 'cpu']} label="CPU" rules={cpuRule}>
          <Input placeholder="500m" />
        </Form.Item>
        <Form.Item name={[name, 'memory']} label="内存" rules={memoryRule}>
          <Input placeholder="512Mi" />
        </Form.Item>
        <Form.Item name={[name, 'gpu']} label="GPU">
          <Input placeholder="1" />
        </Form.Item>
      </div>
      <Typography.Text type="secondary">其它资源</Typography.Text>
      <PairList name={[name, 'extra']} keyPlaceholder="disk" valuePlaceholder="10Gi" addLabel="添加资源项" />
    </>
  );
}

function VolumeEditor({ index, onRemove }: { index: number; onRemove: () => void }) {
  const form = Form.useFormInstance();
  const backend = Form.useWatch(['volumes', index, 'backend'], form) as VolumeFields['backend'] | undefined;

  return (
    <div className="create-volume">
      <div className="create-block-head">
        <Typography.Text strong>卷 {index + 1}</Typography.Text>
        <Button type="text" danger onClick={onRemove}>
          删除
        </Button>
      </div>
      <div className="create-inline-grid two">
        <Form.Item
          name={[index, 'name']}
          label="名称"
          rules={[{ required: true, whitespace: true, message: '请填写卷名称' }]}
          extra="小写字母、数字和连字符"
        >
          <Input placeholder="workdir" />
        </Form.Item>
        <Form.Item
          name={[index, 'mountPath']}
          label="挂载路径"
          rules={[{ required: true, whitespace: true, message: '请填写挂载路径' }]}
        >
          <Input placeholder="/mnt/work" />
        </Form.Item>
      </div>
      <div className="create-inline-grid two">
        <Form.Item name={[index, 'backend']} label="后端" rules={[{ required: true, message: '请选择后端' }]}>
          <Select
            options={[
              { value: 'host', label: '主机路径' },
              { value: 'pvc', label: 'PVC / 命名卷' },
              { value: 'ossfs', label: 'OSS' },
            ]}
          />
        </Form.Item>
        <Form.Item name={[index, 'subPath']} label="子路径" extra="相对路径。OSS 上表示 bucket 前缀">
          <Input placeholder="data" />
        </Form.Item>
      </div>
      <Form.Item name={[index, 'readOnly']} label="只读" valuePropName="checked">
        <Switch />
      </Form.Item>
      {backend === 'host' && (
        <Form.Item
          name={[index, 'hostPath']}
          label="主机路径"
          rules={[{ required: true, whitespace: true, message: '请填写主机路径' }]}
          extra="必须落在服务端允许的路径前缀下"
        >
          <Input placeholder="/data/opensandbox" />
        </Form.Item>
      )}
      {backend === 'pvc' && (
        <>
          <Form.Item
            name={[index, 'claimName']}
            label="卷名"
            rules={[{ required: true, whitespace: true, message: '请填写卷名' }]}
            extra="Kubernetes 上是 PVC 名称，Docker 上是命名卷"
          >
            <Input placeholder="shared-models" />
          </Form.Item>
          <div className="create-inline-grid two">
            <Form.Item name={[index, 'createIfNotExists']} label="不存在时创建" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name={[index, 'deleteOnSandboxTermination']} label="随沙箱删除" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
          <div className="create-inline-grid">
            <Form.Item name={[index, 'storageClass']} label="StorageClass">
              <Input placeholder="留空使用集群默认" />
            </Form.Item>
            <Form.Item name={[index, 'storage']} label="容量">
              <Input placeholder="10Gi" />
            </Form.Item>
            <Form.Item name={[index, 'accessModes']} label="访问模式" extra="逗号分隔">
              <Input placeholder="ReadWriteOnce" />
            </Form.Item>
          </div>
        </>
      )}
      {backend === 'ossfs' && (
        <>
          <div className="create-inline-grid two">
            <Form.Item
              name={[index, 'bucket']}
              label="Bucket"
              rules={[{ required: true, whitespace: true, message: '请填写 bucket' }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name={[index, 'endpoint']}
              label="Endpoint"
              rules={[{ required: true, whitespace: true, message: '请填写 endpoint' }]}
            >
              <Input placeholder="oss-cn-hangzhou.aliyuncs.com" />
            </Form.Item>
          </div>
          <div className="create-inline-grid">
            <Form.Item name={[index, 'ossVersion']} label="ossfs 版本">
              <Select
                options={[
                  { value: '2.0', label: '2.0' },
                  { value: '1.0', label: '1.0' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name={[index, 'accessKeyId']}
              label="AccessKey ID"
              rules={[{ required: true, whitespace: true, message: '请填写 AccessKey ID' }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name={[index, 'accessKeySecret']}
              label="AccessKey Secret"
              rules={[{ required: true, whitespace: true, message: '请填写 AccessKey Secret' }]}
            >
              <Input.Password />
            </Form.Item>
          </div>
          <Form.Item name={[index, 'ossOptions']} label="挂载选项" extra="每行一个，不要以 - 开头">
            <Input.TextArea rows={3} placeholder={'allow_other\numask=022'} />
          </Form.Item>
        </>
      )}
    </div>
  );
}

export function SandboxCreatePage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<SandboxCreateFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const source = (Form.useWatch('source', form) ?? 'image') as SourceKind;
  const timeoutEnabled = Form.useWatch('timeoutEnabled', form);
  const requestsEnabled = Form.useWatch('requestsEnabled', form);
  const platformEnabled = Form.useWatch('platformEnabled', form);
  const networkEnabled = Form.useWatch('networkEnabled', form);
  const preStartEnabled = Form.useWatch('preStartEnabled', form);
  const credentialProxyEnabled = Form.useWatch('credentialProxyEnabled', form);

  useEffect(() => {
    if (source === 'template' && timeoutEnabled === false) {
      form.setFieldValue('timeoutEnabled', true);
    }
  }, [form, source, timeoutEnabled]);

  const showRuntimeShape = source !== 'template';
  const showWorkload = source === 'image' || source === 'snapshot';
  const requireResources = showWorkload;

  const onFinish = async (values: SandboxCreateFormValues) => {
    setSubmitting(true);
    try {
      const created = await sandboxApi.create(buildSandboxCreateBody(values));
      message.success('沙箱已创建');
      navigate(`/sandboxes/${created.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const advanced: NonNullable<CollapseProps['items']> = [];

  if (showWorkload) {
    advanced.push({
      key: 'platform',
      label: '平台',
      children: (
        <>
          <Form.Item name="platformEnabled" label="指定操作系统和架构" valuePropName="checked">
            <Switch />
          </Form.Item>
          {platformEnabled && (
            <div className="create-inline-grid two">
              <Form.Item name="platformOs" label="操作系统" rules={[{ required: true, message: '请选择操作系统' }]}>
                <Select
                  options={[
                    { value: 'linux', label: 'linux' },
                    { value: 'windows', label: 'windows' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="platformArch" label="架构" rules={[{ required: true, message: '请选择架构' }]}>
                <Select
                  options={[
                    { value: 'amd64', label: 'amd64' },
                    { value: 'arm64', label: 'arm64' },
                  ]}
                />
              </Form.Item>
            </div>
          )}
        </>
      ),
    });
  }

  if (showRuntimeShape) {
    advanced.push({
      key: 'env',
      label: '环境变量',
      children: <PairList name="env" keyPlaceholder="KEY" valuePlaceholder="value" addLabel="添加环境变量" />,
    });
  }

  advanced.push({
    key: 'metadata',
    label: '元数据',
    children: (
      <PairList name="metadata" keyPlaceholder="name" valuePlaceholder="demo" addLabel="添加元数据" />
    ),
  });

  if (showWorkload) {
    advanced.push({
      key: 'lifecycle',
      label: '生命周期钩子',
      children: (
        <>
          <Form.Item
            name="preStartEnabled"
            label="启动前执行 preStart"
            valuePropName="checked"
            extra="在用户启动命令之前执行。失败或超时会阻止启动命令运行。"
          >
            <Switch />
          </Form.Item>
          {preStartEnabled && (
            <>
              <Typography.Text type="secondary">preStart 命令</Typography.Text>
              <ArgList name="preStartCommand" addLabel="添加参数" />
              <Form.Item name="preStartTimeout" label="preStart 超时（秒）" extra="留空则由服务端默认 60 秒，最长 10800 秒">
                <InputNumber min={1} max={10800} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
          <Typography.Text strong>周期钩子</Typography.Text>
          <Form.List name="periodic">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <div className="create-hook" key={field.key}>
                    <div className="create-block-head">
                      <Typography.Text>钩子 {field.name + 1}</Typography.Text>
                      <Button type="text" danger onClick={() => remove(field.name)}>
                        删除
                      </Button>
                    </div>
                    <div className="create-inline-grid two">
                      <Form.Item
                        name={[field.name, 'name']}
                        label="名称"
                        rules={[{ required: true, whitespace: true, message: '请填写名称' }]}
                      >
                        <Input placeholder="heartbeat" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'schedule']}
                        label="调度"
                        rules={[{ required: true, whitespace: true, message: '请填写调度' }]}
                        extra="五段 cron，或 @hourly、@every 30s"
                      >
                        <Input placeholder="@every 30s" />
                      </Form.Item>
                    </div>
                    <Typography.Text type="secondary">命令</Typography.Text>
                    <ArgList name={[field.name, 'command']} addLabel="添加参数" />
                    <Form.Item name={[field.name, 'timeoutSeconds']} label="超时（秒）" extra="留空默认 60 秒，最长 300 秒">
                      <InputNumber min={1} max={300} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                ))}
                <Button
                  type="dashed"
                  onClick={() => add({ command: [{ value: '' }] })}
                  block
                  icon={<PlusOutlined />}
                >
                  添加周期钩子
                </Button>
              </>
            )}
          </Form.List>
        </>
      ),
    });
  }

  if (source !== 'pool') {
    advanced.push({
      key: 'network',
      label: '出站网络',
      children: (
        <>
          <Form.Item
            name="networkEnabled"
            label="配置出站网络策略"
            valuePropName="checked"
            extra="关闭时不提交策略，沙箱出站保持默认放行，直到之后更新策略。"
          >
            <Switch />
          </Form.Item>
          {networkEnabled && (
            <>
              <Form.Item name="defaultAction" label="默认动作">
                <Radio.Group>
                  <Radio.Button value="deny">拒绝</Radio.Button>
                  <Radio.Button value="allow">放行</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Typography.Text type="secondary">出站规则</Typography.Text>
              <Form.List name="egress">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field) => (
                      <div className="create-rule-row" key={field.key}>
                        <Form.Item name={[field.name, 'action']} rules={[{ required: true, message: '请选择动作' }]}>
                          <Select
                            options={[
                              { value: 'allow', label: '放行' },
                              { value: 'deny', label: '拒绝' },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          name={[field.name, 'target']}
                          rules={[{ required: true, whitespace: true, message: '请填写域名' }]}
                        >
                          <Input placeholder="*.example.com" />
                        </Form.Item>
                        <Button
                          type="text"
                          aria-label="删除规则"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                        />
                      </div>
                    ))}
                    <Button type="dashed" onClick={() => add({ action: 'allow' })} block icon={<PlusOutlined />}>
                      添加规则
                    </Button>
                  </>
                )}
              </Form.List>
            </>
          )}
          {showWorkload && (
            <>
              <Form.Item
                name="credentialProxyEnabled"
                label="凭据代理"
                valuePropName="checked"
                extra="开启后需要出站网络策略。服务端还需将 egress 配成 dns+nft。"
              >
                <Switch />
              </Form.Item>
              {credentialProxyEnabled && !networkEnabled && (
                <Alert type="warning" showIcon message="凭据代理需要同时配置出站网络策略。" style={{ marginBottom: 16 }} />
              )}
            </>
          )}
        </>
      ),
    });
  }

  if (showWorkload) {
    advanced.push({
      key: 'volumes',
      label: '存储卷',
      children: (
        <Form.List name="volumes">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <VolumeEditor key={field.key} index={field.name} onRemove={() => remove(field.name)} />
              ))}
              <Button
                type="dashed"
                onClick={() => add({ backend: 'host', ossVersion: '2.0', createIfNotExists: true })}
                block
                icon={<PlusOutlined />}
              >
                添加存储卷
              </Button>
            </>
          )}
        </Form.List>
      ),
    });
  }

  advanced.push({
    key: 'extensions',
    label: '扩展参数',
    children: (
      <>
        <Form.Item
          name="renewExtendSeconds"
          label="访问续期（秒）"
          extra="对应 access.renew.extend.seconds，范围 300 到 86400。留空则不开启访问续期。"
        >
          <InputNumber min={300} max={86400} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Typography.Text type="secondary">其它扩展</Typography.Text>
        <PairList name="extensions" keyPlaceholder="storage.id" valuePlaceholder="vol-1" addLabel="添加扩展项" />
      </>
    ),
  });

  return (
    <div className="sandbox-create">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        创建沙箱
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        字段与开发侧创建沙箱的请求一致。留空的可选项不会提交。
      </Typography.Paragraph>
      <Form<SandboxCreateFormValues>
        form={form}
        layout="vertical"
        requiredMark
        scrollToFirstError
        initialValues={{
          source: 'image',
          imageUri: 'hub.glodon.com/glodon-pub/opensandbox-code-interpreter:v1.1.1-slim',
          entrypoint: [{ value: 'tail' }, { value: '-f' }, { value: '/dev/null' }],
          timeoutEnabled: true,
          timeout: 3600,
          limits: { cpu: '500m', memory: '512Mi' },
          defaultAction: 'deny',
          platformOs: 'linux',
          platformArch: 'amd64',
        }}
        onFinish={onFinish}
      >
        <Card title="来源" className="create-block">
          <Form.Item name="source" label="从哪里创建">
            <Radio.Group className="sandbox-create-source">
              <Radio.Button value="image">镜像</Radio.Button>
              <Radio.Button value="snapshot">快照</Radio.Button>
              <Radio.Button value="template">FSB 模板</Radio.Button>
              <Radio.Button value="pool">资源池</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Alert type="info" showIcon message={SOURCE_HINT[source]} />
          {allows(source, ['image', 'pool']) && (
            <>
              <Form.Item
                name="imageUri"
                label="镜像 URI"
                style={{ marginTop: 16 }}
                rules={
                  source === 'image'
                    ? [{ required: true, whitespace: true, message: '请输入镜像' }]
                    : undefined
                }
                extra={source === 'pool' ? '留空则使用资源池模板中的镜像。' : undefined}
              >
                <Input placeholder="hub.glodon.com/glodon-pub/opensandbox-code-interpreter:v1.1.1-slim" />
              </Form.Item>
              <div className="create-inline-grid two">
                <Form.Item name="registryUsername" label="仓库用户名">
                  <Input placeholder="私有仓库时填写" autoComplete="off" />
                </Form.Item>
                <Form.Item name="registryPassword" label="仓库密码">
                  <Input.Password placeholder="密码或 token" autoComplete="new-password" />
                </Form.Item>
              </div>
            </>
          )}
          {source === 'snapshot' && (
            <Form.Item
              name="snapshotId"
              label="快照 ID"
              style={{ marginTop: 16 }}
              rules={[{ required: true, whitespace: true, message: '请填写快照 ID' }]}
            >
              <Input placeholder="snap-1" />
            </Form.Item>
          )}
          {source === 'template' && (
            <Form.Item
              name="templateId"
              label="模板 ID"
              style={{ marginTop: 16 }}
              rules={[{ required: true, whitespace: true, message: '请填写模板 ID' }]}
            >
              <Input placeholder="tpl-1" />
            </Form.Item>
          )}
          {source === 'pool' && (
            <Form.Item
              name="poolRef"
              label="资源池"
              rules={[{ required: true, whitespace: true, message: '请填写资源池名称' }]}
              extra="对应 extensions.poolRef。填写 * 表示由平台自动分配。"
            >
              <Input placeholder="my-pool" />
            </Form.Item>
          )}
        </Card>

        <Card title="运行" className="create-block">
          {showRuntimeShape && (
            <Form.Item
              label="启动命令"
              required={source === 'image'}
              extra="每个输入框是一个参数。带空格的参数放在同一个输入框里。"
            >
              <ArgList
                name="entrypoint"
                addLabel="添加参数"
                rules={
                  source === 'image'
                    ? [
                        {
                          validator: async (_, value) => {
                            const filled = (value ?? []).some((row) => row?.value?.trim());
                            if (!filled) throw new Error('请填写 entrypoint');
                          },
                        },
                      ]
                    : undefined
                }
              />
            </Form.Item>
          )}
          <Form.Item
            name="timeoutEnabled"
            label="自动过期"
            valuePropName="checked"
            extra={
              source === 'template'
                ? '模板模式必须设置超时。'
                : '关闭后沙箱不会自动清理，需要手动删除。部分 Kubernetes 运行时不支持。'
            }
          >
            <Switch disabled={source === 'template'} />
          </Form.Item>
          {timeoutEnabled !== false && (
            <Form.Item
              name="timeout"
              label="超时（秒）"
              rules={[{ required: true, message: '请填写超时' }]}
            >
              <InputNumber min={60} precision={0} style={{ width: 240 }} />
            </Form.Item>
          )}
          {source !== 'template' && (
            <Form.Item
              name="secureAccess"
              label="安全访问"
              valuePropName="checked"
              extra="为端点访问签发凭证。目前仅 Kubernetes ingress gateway 模式支持。"
            >
              <Switch />
            </Form.Item>
          )}
        </Card>

        {showRuntimeShape && (
          <Card
            title="资源"
            className="create-block"
            extra={source === 'pool' ? '可留空' : undefined}
          >
            <Typography.Text strong>资源上限</Typography.Text>
            <ResourceFields name="limits" requireCore={requireResources} />
            <Form.Item
              name="requestsEnabled"
              label="单独设置资源请求"
              valuePropName="checked"
              extra="用于 Kubernetes requests。留空时请求与上限相同。"
            >
              <Switch />
            </Form.Item>
            {requestsEnabled && <ResourceFields name="requests" requireCore={false} />}
          </Card>
        )}

        <Collapse className="create-block" items={advanced} />

        <Space>
          <Button type="primary" htmlType="submit" loading={submitting}>
            创建沙箱
          </Button>
          <Button onClick={() => navigate('/sandboxes')}>取消</Button>
        </Space>
      </Form>
    </div>
  );
}
