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
  CloudSyncOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileAddOutlined,
  PlusOutlined,
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
  Space,
  Table,
  Tag,
  Tree,
  Typography,
  Upload,
  message,
  type UploadProps,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildContextApi } from '../api/client';
import type { BuildContextItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AdminTenantSelect } from '../components/AdminTenantSelect';
import { BuildContextFileEditor } from '../components/BuildContextFileEditor';
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

const CLOUD_SYNC_DEBOUNCE_MS = 900;

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileCount(item: BuildContextItem): number {
  return Object.keys(item.manifest?.files ?? {}).length;
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
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<string | null>(null);

  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const filesRef = useRef(files);
  filesRef.current = files;
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;

  const tenantScope = user?.role === 'admin' ? adminTenant : user?.tenant;
  const adminNeedsTenant = user?.role === 'admin' && !adminTenant;
  const cloudActive = cloudPersisted && !adminNeedsTenant;

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

  useEffect(
    () => () => {
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
    },
    [],
  );

  const ensureDraftContext = useCallback(async (): Promise<string | null> => {
    if (!cloudActive) {
      return null;
    }
    if (draftIdRef.current) {
      return draftIdRef.current;
    }
    const name = displayName.trim() || `草稿 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const created = await buildContextApi.create({ displayName: name, dockerfilePath }, tenantScope);
    setDraftId(created.id);
    setDisplayName(created.displayName);
    draftIdRef.current = created.id;
    return created.id;
  }, [cloudActive, displayName, dockerfilePath, tenantScope]);

  const uploadFileToOss = useCallback(
    async (file: ContextFile, contextId: string) => {
      await buildContextApi.putFile(
        contextId,
        file.relativePath,
        { encoding: file.encoding, content: file.payload },
        tenantScope,
      );
    },
    [tenantScope],
  );

  const syncAllFilesToOss = useCallback(async (): Promise<string | null> => {
    if (!cloudActive) {
      return null;
    }
    if (!validation.ok) {
      throw new Error(validation.errors[0] ?? '构建上下文校验失败');
    }
    setCloudSyncing(true);
    try {
      const contextId = await ensureDraftContext();
      if (!contextId) {
        return null;
      }
      await buildContextApi.patch(
        contextId,
        { displayName: displayName.trim() || undefined, dockerfilePath },
        tenantScope,
      );
      for (const file of filesRef.current) {
        await uploadFileToOss(file, contextId);
      }
      setLastCloudSyncAt(new Date().toLocaleTimeString());
      await refreshCloudDrafts();
      return contextId;
    } finally {
      setCloudSyncing(false);
    }
  }, [
    cloudActive,
    displayName,
    dockerfilePath,
    ensureDraftContext,
    refreshCloudDrafts,
    tenantScope,
    uploadFileToOss,
    validation,
  ]);

  const scheduleCloudFileSync = useCallback(
    (file: ContextFile) => {
      if (!cloudActive) {
        return;
      }
      const key = file.relativePath;
      const existing = debounceTimers.current.get(key);
      if (existing) {
        clearTimeout(existing);
      }
      debounceTimers.current.set(
        key,
        setTimeout(() => {
          void (async () => {
            try {
              setCloudSyncing(true);
              const contextId = await ensureDraftContext();
              if (!contextId) {
                return;
              }
              await uploadFileToOss(file, contextId);
              setLastCloudSyncAt(new Date().toLocaleTimeString());
            } catch (err) {
              message.error(err instanceof Error ? err.message : '同步 OSS 失败');
            } finally {
              setCloudSyncing(false);
            }
          })();
        }, CLOUD_SYNC_DEBOUNCE_MS),
      );
    },
    [cloudActive, ensureDraftContext, uploadFileToOss],
  );

  const updateFileContent = useCallback(
    (path: string, payload: string) => {
      setFiles((prev) => {
        const next = prev.map((file) =>
          file.relativePath === path && file.encoding === 'utf-8' ? { ...file, payload } : file,
        );
        const updated = next.find((file) => file.relativePath === path);
        if (updated) {
          scheduleCloudFileSync(updated);
        }
        return next;
      });
    },
    [scheduleCloudFileSync],
  );

  const removeFile = useCallback(
    (path: string) => {
      void (async () => {
        if (cloudActive && draftId && path !== dockerfilePath) {
          try {
            await buildContextApi.deleteFile(draftId, path, tenantScope);
          } catch (err) {
            message.error(err instanceof Error ? err.message : '删除 OSS 文件失败');
            return;
          }
        }
        setFiles((prev) => prev.filter((file) => file.relativePath !== path));
        if (selectedPath === path) {
          setSelectedPath(DEFAULT_DOCKERFILE_PATH);
        }
      })();
    },
    [cloudActive, draftId, dockerfilePath, selectedPath, tenantScope],
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
    const entry: ContextFile = { relativePath: normalized, encoding: 'utf-8', payload: '' };
    setFiles((prev) => [...prev, entry]);
    setSelectedPath(normalized);
    setNewPath('');
    setAddPathOpen(false);
    scheduleCloudFileSync(entry);
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
      if (cloudActive) {
        setCloudSyncing(true);
        try {
          const contextId = await ensureDraftContext();
          if (contextId) {
            await uploadFileToOss(entry, contextId);
            setLastCloudSyncAt(new Date().toLocaleTimeString());
            message.success(`${entry.relativePath} 已上传到 OSS`);
          }
        } finally {
          setCloudSyncing(false);
        }
      }
      options.onSuccess?.(entry);
    } catch {
      options.onError?.(new Error('upload failed'));
      message.error('无法添加该文件，请检查路径与大小限制。');
    }
  };

  const handleLoadDraft = async (contextId: string) => {
    if (!cloudActive) {
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
      message.success('已加载草稿，可继续编辑');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载草稿失败');
    } finally {
      setCloudLoading(false);
    }
  };

  const handleDeleteDraft = async (contextId: string) => {
    if (!cloudActive) {
      return;
    }
    try {
      await buildContextApi.remove(contextId, tenantScope);
      if (draftId === contextId) {
        setDraftId(null);
        setFiles(createDefaultContextFiles());
        setDockerfilePath(DEFAULT_DOCKERFILE_PATH);
        setSelectedPath(DEFAULT_DOCKERFILE_PATH);
      }
      message.success('已删除草稿');
      await refreshCloudDrafts();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleDownloadTarFromOss = async (contextId: string, buildIfNeeded: boolean) => {
    try {
      let url: string;
      if (buildIfNeeded) {
        await syncAllFilesToOss();
        const built = await buildContextApi.buildTar(contextId, tenantScope);
        url = built.downloadUrl;
      } else {
        const existing = await buildContextApi.getTarUrl(contextId, tenantScope);
        url = existing.downloadUrl;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      if (!buildIfNeeded) {
        const built = await buildContextApi.buildTar(contextId, tenantScope);
        window.open(built.downloadUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      message.error('OSS tar 下载失败');
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

      if (cloudActive) {
        const contextId = await syncAllFilesToOss();
        if (contextId) {
          const built = await buildContextApi.buildTar(contextId, tenantScope);
          message.success('已本地下载，并在 OSS 生成 context.tar.gz');
          window.open(built.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      } else {
        message.success('已下载 context.tar.gz（仅本地）。');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '打包失败');
    } finally {
      setDownloading(false);
    }
  };

  const handleNewDraft = () => {
    setDraftId(null);
    setDisplayName('我的沙箱镜像草稿');
    setFiles(createDefaultContextFiles());
    setDockerfilePath(DEFAULT_DOCKERFILE_PATH);
    setSelectedPath(DEFAULT_DOCKERFILE_PATH);
  };

  const draftColumns = [
    {
      title: '名称',
      dataIndex: 'displayName',
      key: 'displayName',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (status: string) => (
        <Tag color={status === 'ready' ? 'green' : 'blue'}>{status === 'ready' ? '已打包' : '草稿'}</Tag>
      ),
    },
    {
      title: '文件数',
      key: 'files',
      width: 72,
      render: (_: unknown, row: BuildContextItem) => fileCount(row),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 168,
      render: (value: string | undefined) => value?.replace('T', ' ').slice(0, 19) ?? '—',
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, row: BuildContextItem) => (
        <Space size="small" wrap>
          <Button type="link" size="small" onClick={() => void handleLoadDraft(row.id)}>
            继续编辑
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => void handleDownloadTarFromOss(row.id, true)}
          >
            下载 tar
          </Button>
          <Button type="link" size="small" danger onClick={() => void handleDeleteDraft(row.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        沙箱镜像制作
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        编辑 Dockerfile 与构建上下文文件。启用 OSS 后，上传与编辑器内容会自动同步；打包时生成 tar.gz 并写入 OSS 供下载。
      </Typography.Paragraph>

      {user?.role === 'admin' ? (
        <div style={{ marginBottom: 16 }}>
          <AdminTenantSelect value={adminTenant} onChange={setAdminTenant} placeholder="选择租户（云端草稿）" />
        </div>
      ) : null}

      <Card
        title="Dockerfile 半成品列表"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          cloudActive ? (
            <Space>
              <Button size="small" icon={<PlusOutlined />} onClick={handleNewDraft}>
                新建半成品
              </Button>
              {cloudSyncing ? <Tag icon={<CloudSyncOutlined spin />}>同步 OSS</Tag> : null}
              {lastCloudSyncAt ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  最近同步 {lastCloudSyncAt}
                </Typography.Text>
              ) : null}
            </Space>
          ) : null
        }
      >
        {cloudActive ? (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <Input
                addonBefore="当前名称"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => {
                  if (draftId) {
                    void buildContextApi.patch(
                      draftId,
                      { displayName: displayName.trim(), dockerfilePath },
                      tenantScope,
                    );
                  }
                }}
                style={{ minWidth: 280 }}
              />
              {draftId ? (
                <Tag color="processing">编辑中：{draftId.slice(0, 8)}…</Tag>
              ) : (
                <Tag>未绑定草稿（上传或编辑后将自动创建）</Tag>
              )}
            </Space>
            <Table
              rowKey="id"
              size="small"
              loading={cloudLoading}
              dataSource={cloudDrafts}
              columns={draftColumns}
              pagination={{ pageSize: 5, hideOnSinglePage: true }}
              rowClassName={(row) => (row.id === draftId ? 'ant-table-row-selected' : '')}
            />
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            message="云端草稿未配置"
            description="请在 BFF 开启 BFF_HISTORY_ENABLED、BFF_IMAGE_BUILD_ENABLED 与 OSS 凭证。当前仅支持浏览器本地 tar 打包下载。"
          />
        )}
      </Card>

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
          description={`Dockerfile 路径：${validation.dockerfilePath}，共 ${files.length} 个文件。${
            cloudActive ? ' 文本保存约 1 秒后自动上传 OSS。' : ''
          }`}
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
              onBlur={() => {
                if (cloudActive && draftId) {
                  void buildContextApi.patch(draftId, { dockerfilePath }, tenantScope);
                }
              }}
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
          <Space style={{ marginTop: 16 }} wrap>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloading || cloudSyncing}
              onClick={() => void handleDownloadTar()}
            >
              {cloudActive ? '打包 tar.gz（本地 + OSS）' : '下载 context.tar.gz'}
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              docker build -f {dockerfilePath} -t my-sandbox:latest .
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
