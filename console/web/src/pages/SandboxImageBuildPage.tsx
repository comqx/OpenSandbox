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

import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileAddOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Tree,
  Typography,
  Upload,
  message,
  type UploadProps,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { buildContextApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AdminTenantSelect } from '../components/AdminTenantSelect';
import { BuildContextFileEditor } from '../components/BuildContextFileEditor';
import type { BuildContextItem } from '../api/types';
import {
  DEFAULT_DOCKERFILE_PATH,
  type ContextFile,
  bytesToContextFile,
  contextFilesToByteMap,
  createDefaultContextFiles,
  normalizeRelativePath,
  validateBuildContext,
} from '../utils/buildContextModel';
import { packBuildContextTarGz } from '../utils/buildContextTar';
import { buildContextTreeData } from '../utils/buildContextTree';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SandboxImageBuildPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<ContextFile[]>(() => createDefaultContextFiles());
  const [dockerfilePath, setDockerfilePath] = useState(DEFAULT_DOCKERFILE_PATH);
  const [selectedPath, setSelectedPath] = useState<string>(DEFAULT_DOCKERFILE_PATH);
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [displayName, setDisplayName] = useState('我的沙箱镜像草稿');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [cloudPersisted, setCloudPersisted] = useState(false);
  const [cloudDrafts, setCloudDrafts] = useState<BuildContextItem[]>([]);
  const [adminTenant, setAdminTenant] = useState('');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudSaving, setCloudSaving] = useState(false);

  const tenantScope = user?.role === 'admin' ? adminTenant : user?.tenant;
  const adminNeedsTenant = user?.role === 'admin' && !adminTenant;
  const pathList = useMemo(() => files.map((file) => file.relativePath), [files]);
  const treeData = useMemo(() => buildContextTreeData(pathList), [pathList]);

  const selectedFile = files.find((file) => file.relativePath === selectedPath);

  const validation = useMemo(() => validateBuildContext(files, dockerfilePath), [files, dockerfilePath]);

  const refreshCloudDrafts = useCallback(async () => {
    if (adminNeedsTenant) {
      setCloudPersisted(false);
      setCloudDrafts([]);
      return;
    }
    setCloudLoading(true);
    try {
      const data = await buildContextApi.list(tenantScope);
      setCloudPersisted(Boolean(data.persisted));
      setCloudDrafts(data.items ?? []);
    } catch {
      setCloudPersisted(false);
      setCloudDrafts([]);
    } finally {
      setCloudLoading(false);
    }
  }, [adminNeedsTenant, tenantScope]);

  useEffect(() => {
    void refreshCloudDrafts();
  }, [refreshCloudDrafts]);

  const updateFileContent = useCallback((path: string, payload: string) => {
    setFiles((prev) =>
      prev.map((file) =>
        file.relativePath === path && file.encoding === 'utf-8' ? { ...file, payload } : file,
      ),
    );
  }, []);

  const removeFile = useCallback(
    (path: string) => {
      setFiles((prev) => prev.filter((file) => file.relativePath !== path));
      if (selectedPath === path) {
        setSelectedPath(DEFAULT_DOCKERFILE_PATH);
      }
    },
    [selectedPath],
  );

  const addEmptyFile = () => {
    const normalized = normalizeRelativePath(newPath);
    if (!normalized) {
      message.error('请输入有效的相对路径（不含 .. 或绝对路径）。');
      return;
    }
    if (files.some((file) => file.relativePath === normalized)) {
      message.error('路径已存在。');
      return;
    }
    setFiles((prev) => [...prev, { relativePath: normalized, encoding: 'utf-8', payload: '' }]);
    setSelectedPath(normalized);
    setNewPath('');
    setAddPathOpen(false);
  };

  const ingestUpload: UploadProps['customRequest'] = async (options) => {
    const rawFile = options.file as File;
    try {
      const buffer = await rawFile.arrayBuffer();
      const relative =
        normalizeRelativePath(rawFile.webkitRelativePath || rawFile.name) ??
        normalizeRelativePath(rawFile.name);
      if (!relative) {
        throw new Error('invalid path');
      }
      const entry = bytesToContextFile(relative, new Uint8Array(buffer));
      setFiles((prev) => {
        const without = prev.filter((file) => file.relativePath !== entry.relativePath);
        return [...without, entry];
      });
      setSelectedPath(entry.relativePath);
      options.onSuccess?.(entry);
    } catch {
      options.onError?.(new Error('upload failed'));
      message.error('无法添加该文件，请检查路径与大小限制。');
    }
  };

  const handleSaveDraft = async () => {
    if (!cloudPersisted || adminNeedsTenant) {
      message.warning('云端草稿未启用，或 Admin 需先选择租户。');
      return;
    }
    if (!validation.ok) {
      message.error(validation.errors[0] ?? '构建上下文校验失败');
      return;
    }
    const name = displayName.trim();
    if (!name) {
      message.error('请填写草稿名称。');
      return;
    }
    setCloudSaving(true);
    try {
      let contextId = draftId;
      if (!contextId) {
        const created = await buildContextApi.create(
          { displayName: name, dockerfilePath },
          tenantScope,
        );
        contextId = created.id;
        setDraftId(contextId);
      } else {
        await buildContextApi.patch(contextId, { displayName: name, dockerfilePath }, tenantScope);
      }
      for (const file of files) {
        await buildContextApi.putFile(
          contextId,
          file.relativePath,
          { encoding: file.encoding, content: file.payload },
          tenantScope,
        );
      }
      message.success('草稿已保存到 PostgreSQL + OSS');
      await refreshCloudDrafts();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存草稿失败');
    } finally {
      setCloudSaving(false);
    }
  };

  const handleLoadDraft = async (contextId: string) => {
    if (!cloudPersisted || adminNeedsTenant) {
      return;
    }
    setCloudLoading(true);
    try {
      const ctx = await buildContextApi.get(contextId, tenantScope);
      const paths = Object.keys(ctx.manifest?.files ?? {});
      const loaded: ContextFile[] = [];
      for (const path of paths) {
        const remote = await buildContextApi.getFile(contextId, path, tenantScope);
        loaded.push({
          relativePath: remote.path,
          encoding: remote.encoding,
          payload: remote.content,
        });
      }
      if (loaded.length === 0) {
        loaded.push(...createDefaultContextFiles());
      }
      setFiles(loaded);
      setDockerfilePath(ctx.dockerfilePath || DEFAULT_DOCKERFILE_PATH);
      setDisplayName(ctx.displayName);
      setDraftId(ctx.id);
      setSelectedPath(ctx.dockerfilePath || DEFAULT_DOCKERFILE_PATH);
      message.success('已加载云端草稿');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载草稿失败');
    } finally {
      setCloudLoading(false);
    }
  };

  const handleDownloadTar = async () => {
    if (!validation.ok) {
      message.error(validation.errors[0] ?? '构建上下文校验失败');
      return;
    }
    setDownloading(true);
    try {
      const byteMap = contextFilesToByteMap(files);
      const gz = await packBuildContextTarGz(byteMap);
      downloadBlob(new Blob([gz], { type: 'application/gzip' }), 'sandbox-build-context.tar.gz');
      message.success('已下载 context.tar.gz，可在本地 docker build 使用。');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '打包失败');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        沙箱镜像制作
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        编辑 Docker 构建上下文：可本地下载 tar.gz，或在启用 BFF 历史库与 OSS 后保存租户草稿。
      </Typography.Paragraph>

      {user?.role === 'admin' ? (
        <div style={{ marginBottom: 16 }}>
          <AdminTenantSelect value={adminTenant} onChange={setAdminTenant} placeholder="选择租户（云端草稿）" />
        </div>
      ) : null}

      {cloudPersisted ? (
        <Card title="云端草稿（Phase 2a）" size="small" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Input
              addonBefore="名称"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="草稿显示名称"
            />
            <Space wrap>
              <Button
                icon={<CloudUploadOutlined />}
                loading={cloudSaving}
                disabled={adminNeedsTenant}
                onClick={() => void handleSaveDraft()}
              >
                保存草稿
              </Button>
              <Select
                style={{ minWidth: 260 }}
                placeholder="加载已有草稿"
                loading={cloudLoading}
                disabled={adminNeedsTenant}
                options={cloudDrafts.map((item) => ({
                  value: item.id,
                  label: `${item.displayName} (${item.updatedAt?.slice(0, 10) ?? item.id.slice(0, 8)})`,
                }))}
                onChange={(value) => void handleLoadDraft(value)}
                value={draftId ?? undefined}
              />
              {draftId ? (
                <Button
                  icon={<CloudDownloadOutlined />}
                  disabled={adminNeedsTenant}
                  onClick={() =>
                    void (async () => {
                      try {
                        const tar = await buildContextApi.buildTar(draftId, tenantScope);
                        window.open(tar.downloadUrl, '_blank', 'noopener,noreferrer');
                      } catch (err) {
                        message.error(err instanceof Error ? err.message : '生成 OSS tar 失败');
                      }
                    })()
                  }
                >
                  OSS 打包下载
                </Button>
              ) : null}
            </Space>
            {draftId ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前草稿 ID：{draftId}
              </Typography.Text>
            ) : null}
          </Space>
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="云端草稿未配置"
          description="开启 BFF_HISTORY_ENABLED、BFF_IMAGE_BUILD_ENABLED 与 OSS 凭证后可保存草稿；当前仍可使用本地下载。"
        />
      )}

      {!validation.ok ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="构建上下文待完善"
          description={
            <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
              {validation.errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message="构建上下文已通过校验"
          description={`Dockerfile 路径：${validation.dockerfilePath}，共 ${files.length} 个文件。`}
        />
      )}

      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Card
            title="文件树"
            size="small"
            extra={
              <Space size={4}>
                <Button size="small" icon={<FileAddOutlined />} onClick={() => setAddPathOpen(true)}>
                  新建
                </Button>
                <Upload customRequest={ingestUpload} showUploadList={false} multiple>
                  <Button size="small" icon={<UploadOutlined />}>
                    上传
                  </Button>
                </Upload>
              </Space>
            }
          >
            {treeData.length === 0 ? (
              <Typography.Text type="secondary">暂无文件</Typography.Text>
            ) : (
              <Tree
                treeData={treeData}
                selectedKeys={[selectedPath]}
                onSelect={(keys) => {
                  const key = keys[0];
                  if (typeof key === 'string' && !key.startsWith('dir:')) {
                    setSelectedPath(key);
                  }
                }}
                defaultExpandAll
              />
            )}
          </Card>
          <Card title="Dockerfile 路径" size="small" style={{ marginTop: 16 }}>
            <Input
              value={dockerfilePath}
              onChange={(event) => setDockerfilePath(event.target.value)}
              placeholder="Dockerfile"
            />
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card
            title={selectedFile ? selectedFile.relativePath : '选择文件'}
            size="small"
            extra={
              selectedFile ? (
                <Space>
                  <Tag color={selectedFile.encoding === 'utf-8' ? 'blue' : 'purple'}>
                    {selectedFile.encoding}
                  </Tag>
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    disabled={selectedFile.relativePath === dockerfilePath}
                    onClick={() => removeFile(selectedFile.relativePath)}
                  >
                    删除
                  </Button>
                </Space>
              ) : null
            }
          >
            {selectedFile ? (
              selectedFile.encoding === 'utf-8' ? (
                <BuildContextFileEditor
                  value={selectedFile.payload}
                  onChange={(value) => updateFileContent(selectedFile.relativePath, value)}
                />
              ) : (
                <Typography.Paragraph type="secondary">
                  二进制文件（{selectedFile.relativePath}）请重新上传替换，暂不支持在线编辑。
                </Typography.Paragraph>
              )
            ) : (
              <Typography.Text type="secondary">在左侧选择要编辑的文件。</Typography.Text>
            )}
          </Card>
          <Space style={{ marginTop: 16 }}>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloading}
              onClick={() => void handleDownloadTar()}
            >
              下载 context.tar.gz
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              本地示例：docker build -f {dockerfilePath} -t my-sandbox:latest .
            </Typography.Text>
          </Space>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 24 }}
        message="后续步骤（规划中）"
        description="远程集群构建、构建日志、写入沙箱镜像列表与 SDK 引用将在 Phase 2b 对接构建服务。"
      />

      <Modal
        title="新建文件"
        open={addPathOpen}
        onOk={addEmptyFile}
        onCancel={() => setAddPathOpen(false)}
        okText="添加"
      >
        <Input
          placeholder="例如 scripts/bootstrap.sh"
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          onPressEnter={addEmptyFile}
        />
      </Modal>
    </div>
  );
}
