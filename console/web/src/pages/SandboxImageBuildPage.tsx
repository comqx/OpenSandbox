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
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DragOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Dropdown,
  Input,
  Drawer,
  Modal,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
  type UploadProps,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, buildContextApi } from '../api/client';
import type { BuildContextItem, BuildJob } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AdminTenantSelect } from '../components/AdminTenantSelect';
import { BuildContextFileEditor } from '../components/BuildContextFileEditor';
import { BuildContextFileTree } from '../components/BuildContextFileTree';
import {
  DEFAULT_DOCKERFILE_PATH,
  type ContextFile,
  bytesToContextFile,
  contextFilesToByteMap,
  buildContextDirectoryPlaceholder,
  buildMovedRelativePath,
  createDefaultContextFiles,
  normalizeRelativePath,
  resolveUploadRelativePath,
  validateBuildContext,
} from '../utils/buildContextModel';
import { packBuildContextTar } from '../utils/buildContextTar';
import { parseBuildLogData, type BuildLogEntry } from '../utils/buildImageLog';
import {
  BUILD_IMAGE_PREFIX,
  buildImageNameError,
  composeBuildImageName,
  imageSuffixFromInput,
} from '../utils/buildImageName';
import { listBuildContextDirectories } from '../utils/buildContextTree';

const CLOUD_SYNC_DEBOUNCE_MS = 900;

type SaveDraftMeta = {
  displayName: string;
  buildVersion: string;
  remark: string;
};

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

function buildLogsUrl(contextId: string, taskId: string, tenant?: string): string {
  const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
  return `/api/images/build-contexts/${encodeURIComponent(contextId)}/builds/${encodeURIComponent(taskId)}/logs${query}`;
}

function buildStatusTag(job?: BuildJob | null) {
  if (!job) {
    return null;
  }
  const label =
    job.status === 'building'
      ? '构建中'
      : job.status === 'success'
        ? '构建成功'
        : job.status === 'failed'
          ? '构建失败'
          : job.status === 'cleaned'
            ? '日志已清理'
            : job.status;
  const color =
    job.status === 'success' ? 'green' : job.status === 'failed' ? 'red' : job.status === 'cleaned' ? 'orange' : 'processing';
  return <Tag color={color}>{label}</Tag>;
}

function buildResultText(result: Extract<BuildLogEntry, { kind: 'result' }>): string {
  if (result.status === 'success') {
    return '构建成功。镜像已写入沙箱镜像列表，地址是本次提交的镜像 tag。';
  }
  if (result.status === 'cleaned') {
    return result.message || '构建日志已清理';
  }
  return result.message || '构建失败';
}

export function SandboxImageBuildPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<ContextFile[]>(() => createDefaultContextFiles());
  const [dockerfilePath, setDockerfilePath] = useState(DEFAULT_DOCKERFILE_PATH);
  const [selectedPath, setSelectedPath] = useState<string>(DEFAULT_DOCKERFILE_PATH);
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [createKind, setCreateKind] = useState<'file' | 'directory'>('file');
  const [newPath, setNewPath] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [displayName, setDisplayName] = useState('我的沙箱镜像草稿');
  const [draftVersion, setDraftVersion] = useState('1.0.0');
  const [draftRemark, setDraftRemark] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saveDraftOpen, setSaveDraftOpen] = useState(false);
  const [saveFormName, setSaveFormName] = useState('');
  const [saveFormVersion, setSaveFormVersion] = useState('1.0.0');
  const [saveFormRemark, setSaveFormRemark] = useState('');
  const [cloudPersisted, setCloudPersisted] = useState(false);
  const [cloudDrafts, setCloudDrafts] = useState<BuildContextItem[]>([]);
  const [adminTenant, setAdminTenant] = useState('');
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<string | null>(null);
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildContextId, setBuildContextId] = useState<string | null>(null);
  const [buildImageSuffix, setBuildImageSuffix] = useState('');
  const [buildArch, setBuildArch] = useState<'1' | '2'>('1');
  const [buildSubmitting, setBuildSubmitting] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logResult, setLogResult] = useState<Extract<BuildLogEntry, { kind: 'result' }> | null>(null);

  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const logSourceRef = useRef<EventSource | null>(null);
  const buildWatchersRef = useRef<Map<string, EventSource>>(new Map());
  const settledBuildsRef = useRef<Set<string>>(new Set());
  const logViewRef = useRef<HTMLPreElement | null>(null);
  const folderUploadToastRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderUploadCountRef = useRef(0);
  const filesRef = useRef(files);
  filesRef.current = files;
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;

  const tenantScope = user?.role === 'admin' ? adminTenant : user?.tenant;
  const adminNeedsTenant = user?.role === 'admin' && !adminTenant;
  const cloudActive = cloudPersisted && !adminNeedsTenant;

  const pathList = useMemo(() => files.map((file) => file.relativePath), [files]);
  const moveDirectoryOptions = useMemo(() => listBuildContextDirectories(pathList), [pathList]);
  const selectedFile = files.find((file) => file.relativePath === selectedPath);
  const canMoveSelected = Boolean(selectedPath && selectedPath !== dockerfilePath);
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
      if (folderUploadToastRef.current) {
        clearTimeout(folderUploadToastRef.current);
      }
      logSourceRef.current?.close();
      for (const source of buildWatchersRef.current.values()) {
        source.close();
      }
      buildWatchersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const active = new Set<string>();
    for (const draft of cloudDrafts) {
      const job = draft.latestBuild;
      if (job?.status !== 'building') {
        continue;
      }
      const key = `${draft.id}:${job.taskId}`;
      active.add(key);
      if (settledBuildsRef.current.has(key) || buildWatchersRef.current.has(key)) {
        continue;
      }
      const source = new EventSource(buildLogsUrl(draft.id, job.taskId, tenantScope));
      source.onmessage = (event) => {
        const parsed = parseBuildLogData(event.data);
        if (parsed?.kind !== 'result') {
          return;
        }
        settledBuildsRef.current.add(key);
        source.close();
        buildWatchersRef.current.delete(key);
        void refreshCloudDrafts();
      };
      buildWatchersRef.current.set(key, source);
    }
    for (const [key, source] of buildWatchersRef.current) {
      if (!active.has(key)) {
        source.close();
        buildWatchersRef.current.delete(key);
      }
    }
  }, [cloudDrafts, refreshCloudDrafts, tenantScope]);

  useEffect(() => {
    const view = logViewRef.current;
    if (view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [logLines, logResult]);

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

  const syncAllFilesToOss = useCallback(
    async (meta?: SaveDraftMeta): Promise<string | null> => {
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
        if (meta) {
          const name = meta.displayName.trim();
          const version = meta.buildVersion.trim();
          if (!name) {
            throw new Error('请填写镜像名称');
          }
          if (!version) {
            throw new Error('请填写版本号');
          }
          await buildContextApi.patch(
            contextId,
            {
              displayName: name,
              dockerfilePath,
              buildVersion: version,
              remark: meta.remark.trim(),
            },
            tenantScope,
          );
        }
        for (const file of filesRef.current) {
          await uploadFileToOss(file, contextId);
        }
        setLastCloudSyncAt(new Date().toLocaleTimeString());
        await refreshCloudDrafts();
        return contextId;
      } finally {
        setCloudSyncing(false);
      }
    },
    [cloudActive, dockerfilePath, ensureDraftContext, refreshCloudDrafts, tenantScope, uploadFileToOss, validation],
  );

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

  const moveFile = useCallback(
    async (fromPath: string, toPath: string) => {
      const normalized = normalizeRelativePath(toPath);
      if (!normalized || normalized === fromPath) {
        return;
      }
      if (fromPath === dockerfilePath) {
        message.error('Dockerfile 入口文件不能移动');
        return;
      }
      const source = filesRef.current.find((file) => file.relativePath === fromPath);
      if (!source) {
        return;
      }
      if (filesRef.current.some((file) => file.relativePath === normalized)) {
        message.error(`目标路径已存在：${normalized}`);
        return;
      }
      const moved: ContextFile = { ...source, relativePath: normalized };
      if (cloudActive && draftId) {
        setCloudSyncing(true);
        try {
          await uploadFileToOss(moved, draftId);
          await buildContextApi.deleteFile(draftId, fromPath, tenantScope);
          setLastCloudSyncAt(new Date().toLocaleTimeString());
        } catch (err) {
          message.error(err instanceof Error ? err.message : '移动文件失败（OSS）');
          return;
        } finally {
          setCloudSyncing(false);
        }
      }
      setFiles((prev) => [...prev.filter((file) => file.relativePath !== fromPath), moved]);
      if (selectedPath === fromPath) {
        setSelectedPath(normalized);
      }
      message.success(`已移动到 ${normalized}`);
    },
    [cloudActive, dockerfilePath, draftId, selectedPath, tenantScope, uploadFileToOss],
  );

  const moveSelectedToDirectory = (dirPath: string) => {
    if (!selectedPath || selectedPath === dockerfilePath) {
      message.error('请先选择要移动的文件（Dockerfile 不可移动）');
      return;
    }
    const dropKey = dirPath === '' ? 'dir:__context_root__' : `dir:${dirPath}`;
    const target = buildMovedRelativePath(selectedPath, dropKey);
    if (!target) {
      message.error('无法移动到该目录');
      return;
    }
    if (target === selectedPath) {
      message.info('文件已在该目录下');
      return;
    }
    void moveFile(selectedPath, target);
  };

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

  const openCreateModal = (kind: 'file' | 'directory') => {
    setCreateKind(kind);
    setNewPath('');
    setAddPathOpen(true);
  };

  const addContextEntry = () => {
    if (createKind === 'directory') {
      const placeholder = buildContextDirectoryPlaceholder(newPath);
      if (!placeholder) {
        message.error('请输入有效的目录路径（不含 .. 或绝对路径）。');
        return;
      }
      const dir = placeholder.slice(0, placeholder.lastIndexOf('/'));
      if (files.some((file) => file.relativePath === placeholder)) {
        message.error('该目录已存在。');
        return;
      }
      if (files.some((file) => file.relativePath === dir)) {
        message.error(`已存在同名文件：${dir}`);
        return;
      }
      const entry: ContextFile = { relativePath: placeholder, encoding: 'utf-8', payload: '' };
      setFiles((prev) => [...prev, entry]);
      setSelectedPath(placeholder);
      setNewPath('');
      setAddPathOpen(false);
      scheduleCloudFileSync(entry);
      message.success(`已创建目录 ${dir}/`);
      return;
    }

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

  const ingestUpload = useCallback(
    (mode: 'file' | 'directory'): UploadProps['customRequest'] =>
      async (options) => {
        const rawFile = options.file as File;
        try {
          const relative = resolveUploadRelativePath(
            rawFile.webkitRelativePath,
            rawFile.name,
            mode,
          );
          if (!relative) {
            throw new Error('invalid path');
          }
          const buffer = await rawFile.arrayBuffer();
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
              }
            } finally {
              setCloudSyncing(false);
            }
          }
          if (mode === 'directory') {
            folderUploadCountRef.current += 1;
            if (folderUploadToastRef.current) {
              clearTimeout(folderUploadToastRef.current);
            }
            folderUploadToastRef.current = setTimeout(() => {
              const count = folderUploadCountRef.current;
              folderUploadCountRef.current = 0;
              folderUploadToastRef.current = null;
              message.success(
                cloudActive
                  ? `已从文件夹导入 ${count} 个文件并同步 OSS`
                  : `已从文件夹导入 ${count} 个文件`,
              );
            }, 400);
          } else {
            message.success(
              cloudActive
                ? `${entry.relativePath} 已添加并同步 OSS`
                : `${entry.relativePath} 已添加到构建上下文`,
            );
          }
          options.onSuccess?.(entry);
        } catch {
          options.onError?.(new Error('upload failed'));
          message.error('无法添加该文件，请检查路径与大小限制。');
        }
      },
    [cloudActive, ensureDraftContext, uploadFileToOss],
  );

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
      setDraftVersion(ctx.buildVersion?.trim() || ctx.manifest?.buildVersion?.trim() || '1.0.0');
      setDraftRemark(ctx.remark?.trim() || ctx.manifest?.remark?.trim() || '');
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
        if (contextId === draftIdRef.current) {
          await syncAllFilesToOss();
        }
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

  const openSaveDraftModal = () => {
    if (!cloudActive) {
      message.warning('云端草稿未配置，无法保存。请开启 BFF 历史库与镜像制作 OSS。');
      return;
    }
    if (!validation.ok) {
      message.error(validation.errors[0] ?? '构建上下文校验失败');
      return;
    }
    setSaveFormName(displayName.trim() || '我的沙箱镜像草稿');
    setSaveFormVersion(draftVersion.trim() || '1.0.0');
    setSaveFormRemark(draftRemark);
    setSaveDraftOpen(true);
  };

  const confirmSaveDraft = async () => {
    const meta: SaveDraftMeta = {
      displayName: saveFormName,
      buildVersion: saveFormVersion,
      remark: saveFormRemark,
    };
    try {
      await syncAllFilesToOss(meta);
      setDisplayName(meta.displayName.trim());
      setDraftVersion(meta.buildVersion.trim());
      setDraftRemark(meta.remark.trim());
      setSaveDraftOpen(false);
      message.success(`草稿「${meta.displayName.trim()}」v${meta.buildVersion.trim()} 已保存`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存草稿失败');
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
      const tar = packBuildContextTar(byteMap);
      downloadBlob(new Blob([tar], { type: 'application/x-tar' }), 'sandbox-build-context.tar');
      message.success('已下载构建上下文 tar（可直接 tar xf / docker build）');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '打包失败');
    } finally {
      setDownloading(false);
    }
  };

  const closeBuildLogs = useCallback(() => {
    logSourceRef.current?.close();
    logSourceRef.current = null;
  }, []);

  const openBuildLogs = useCallback(
    (contextId: string, taskId: string) => {
      closeBuildLogs();
      setLogLines([]);
      setLogResult(null);
      setLogOpen(true);
      const source = new EventSource(buildLogsUrl(contextId, taskId, tenantScope));
      logSourceRef.current = source;
      source.onopen = () => {
        setLogLines([]);
        setLogResult(null);
      };
      source.addEventListener('log', (event) => {
        const parsed = parseBuildLogData((event as MessageEvent<string>).data);
        if (parsed?.kind === 'log') {
          setLogLines((prev) => [...prev, parsed.line]);
        }
      });
      source.onmessage = (event) => {
        const parsed = parseBuildLogData(event.data);
        if (parsed?.kind !== 'result') {
          return;
        }
        setLogResult(parsed);
        source.close();
        if (logSourceRef.current === source) {
          logSourceRef.current = null;
        }
        void refreshCloudDrafts();
      };
    },
    [closeBuildLogs, refreshCloudDrafts, tenantScope],
  );

  const openBuildForm = (contextId: string | null) => {
    setBuildContextId(contextId);
    setBuildImageSuffix('');
    setBuildArch('1');
    setBuildOpen(true);
  };

  const handleBuildClick = (contextId: string | null, contextDockerfile: string, latest?: BuildJob | null) => {
    if (!cloudActive) {
      message.warning('云端草稿未配置，无法提交构建。');
      return;
    }
    if (latest?.status === 'building') {
      if (!contextId) {
        return;
      }
      openBuildLogs(contextId, latest.taskId);
      return;
    }
    if (contextDockerfile !== DEFAULT_DOCKERFILE_PATH) {
      message.error('tar 包根目录缺少 Dockerfile');
      return;
    }
    openBuildForm(contextId);
  };

  const confirmBuild = async () => {
    const nameError = buildImageNameError(buildImageSuffix);
    if (nameError) {
      message.error(nameError);
      return;
    }
    const imageName = composeBuildImageName(buildImageSuffix);
    setBuildSubmitting(true);
    try {
      let contextId = buildContextId;
      const editingCurrent = !contextId || contextId === draftIdRef.current;
      if (editingCurrent) {
        if (dockerfilePath !== DEFAULT_DOCKERFILE_PATH) {
          message.error('tar 包根目录缺少 Dockerfile');
          return;
        }
        contextId = await syncAllFilesToOss();
      }
      if (!contextId) {
        throw new Error('草稿未创建');
      }
      const job = await buildContextApi.submitBuild(
        contextId,
        { imageName, basicStruct: buildArch },
        tenantScope,
      );
      setBuildOpen(false);
      openBuildLogs(contextId, job.taskId);
      void refreshCloudDrafts();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'IMAGE_BUILD_IN_PROGRESS') {
        setBuildOpen(false);
        const data = await buildContextApi.list(tenantScope);
        setCloudPersisted(Boolean(data.persisted));
        setCloudDrafts(data.items ?? []);
        const row = (data.items ?? []).find((item) => item.id === (buildContextId ?? draftIdRef.current));
        if (row?.latestBuild?.status === 'building') {
          openBuildLogs(row.id, row.latestBuild.taskId);
          return;
        }
      }
      message.error(err instanceof Error ? err.message : '提交构建失败');
    } finally {
      setBuildSubmitting(false);
    }
  };

  const handleNewDraft = () => {
    setDraftId(null);
    setDisplayName('我的沙箱镜像草稿');
    setDraftVersion('1.0.0');
    setDraftRemark('');
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
      render: (name: string, row: BuildContextItem) => (
        <Space size={4} wrap>
          <span>{name}</span>
          {buildStatusTag(row.latestBuild)}
        </Space>
      ),
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
      title: '版本',
      key: 'buildVersion',
      width: 96,
      ellipsis: true,
      render: (_: unknown, row: BuildContextItem) =>
        row.buildVersion?.trim() || row.manifest?.buildVersion?.trim() || '—',
    },
    {
      title: '备注',
      key: 'remark',
      width: 120,
      ellipsis: true,
      render: (_: unknown, row: BuildContextItem) =>
        row.remark?.trim() || row.manifest?.remark?.trim() || '—',
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
      width: 320,
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
          <Button
            type="link"
            size="small"
            disabled={!cloudActive || (row.latestBuild?.status !== 'building' && row.dockerfilePath !== 'Dockerfile')}
            onClick={() => handleBuildClick(row.id, row.dockerfilePath, row.latestBuild)}
          >
            {row.latestBuild?.status === 'building' ? '查看日志' : '构建镜像'}
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
        编辑 Dockerfile 与构建上下文文件。启用 OSS 后，上传与编辑器内容会自动同步；打包为未压缩 tar 并写入 OSS 供下载。
      </Typography.Paragraph>

      {user?.role === 'admin' ? (
        <div style={{ marginBottom: 16 }}>
          <AdminTenantSelect value={adminTenant} onChange={setAdminTenant} placeholder="选择租户（云端草稿）" />
        </div>
      ) : null}

      {cloudActive ? (
        <Card
          title="镜像 Dockerfile 列表"
          size="small"
          style={{ marginBottom: 16 }}
          extra={
            <Space>
              <Button size="small" icon={<PlusOutlined />} onClick={handleNewDraft}>
                新建 Dockerfile
              </Button>
              {cloudSyncing ? <Tag icon={<CloudSyncOutlined spin />}>同步 OSS</Tag> : null}
              {lastCloudSyncAt ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  最近同步 {lastCloudSyncAt}
                </Typography.Text>
              ) : null}
            </Space>
          }
        >
          <Space style={{ marginBottom: 12 }} wrap>
            {draftId ? (
              <>
                <Tag color="processing">编辑中：{displayName}</Tag>
                {draftVersion.trim() ? <Tag>v{draftVersion.trim()}</Tag> : null}
                {draftRemark.trim() ? (
                  <Typography.Text type="secondary" ellipsis style={{ maxWidth: 240 }}>
                    {draftRemark.trim()}
                  </Typography.Text>
                ) : null}
              </>
            ) : (
              <Tag>未绑定条目（上传或编辑后将自动创建，保存时请填写名称与版本）</Tag>
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
        </Card>
      ) : null}

      <Row gutter={16}>
        <Col xs={24} md={8}>
          <Card
            title="文件树"
            size="small"
            extra={
              <Space size={4}>
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      {
                        key: 'file',
                        icon: <FileAddOutlined />,
                        label: '新建文件',
                        onClick: () => openCreateModal('file'),
                      },
                      {
                        key: 'directory',
                        icon: <FolderAddOutlined />,
                        label: '新建目录',
                        onClick: () => openCreateModal('directory'),
                      },
                    ],
                  }}
                >
                  <Button size="small" icon={<FileAddOutlined />}>
                    新建
                  </Button>
                </Dropdown>
                <Dropdown
                  trigger={['click']}
                  dropdownRender={() => (
                    <div
                      style={{
                        padding: 8,
                        background: 'var(--ant-color-bg-elevated, #fff)',
                        borderRadius: 8,
                        boxShadow: 'var(--ant-box-shadow-secondary)',
                        minWidth: 168,
                      }}
                    >
                      <Upload
                        customRequest={ingestUpload('file')}
                        showUploadList={false}
                        multiple
                      >
                        <Button block type="text" icon={<UploadOutlined />} style={{ justifyContent: 'flex-start' }}>
                          选择文件
                        </Button>
                      </Upload>
                      <Upload
                        customRequest={ingestUpload('directory')}
                        showUploadList={false}
                        directory
                        multiple
                      >
                        <Button
                          block
                          type="text"
                          icon={<FolderOpenOutlined />}
                          style={{ justifyContent: 'flex-start' }}
                        >
                          选择文件夹
                        </Button>
                      </Upload>
                    </div>
                  )}
                >
                  <Button size="small" icon={<UploadOutlined />}>
                    上传
                  </Button>
                </Dropdown>
                <Dropdown
                  trigger={['click']}
                  disabled={!canMoveSelected}
                  menu={{
                    items: [
                      {
                        key: '__root__',
                        label: 'build-context（根目录）',
                        onClick: () => moveSelectedToDirectory(''),
                      },
                      ...moveDirectoryOptions.map((dir) => ({
                        key: dir,
                        label: dir,
                        onClick: () => moveSelectedToDirectory(dir),
                      })),
                    ],
                  }}
                >
                  <Button size="small" icon={<DragOutlined />} disabled={!canMoveSelected}>
                    移动
                  </Button>
                </Dropdown>
              </Space>
            }
          >
            <BuildContextFileTree
              paths={pathList}
              selectedPath={selectedPath}
              dockerfilePath={dockerfilePath}
              onSelectPath={setSelectedPath}
              onMoveFile={(from, to) => void moveFile(from, to)}
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              单击文件或目录会复制相对路径。选中文件后可编辑，也可「移动」或拖到文件夹。
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card
            title={
              selectedFile ? (
                <Typography.Text
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const path = selectedFile.relativePath;
                    void navigator.clipboard.writeText(path).then(
                      () => message.success(`已复制 ${path}`),
                      () => message.error('复制失败'),
                    );
                  }}
                >
                  {selectedFile.relativePath}
                </Typography.Text>
              ) : (
                '选择文件'
              )
            }
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
                  filePath={selectedFile.relativePath}
                  dockerfilePath={dockerfilePath}
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
          <Card size="small" style={{ marginTop: 16 }} title="操作">
            <Space wrap size="middle" align="center">
              <Tooltip title={dockerfilePath === DEFAULT_DOCKERFILE_PATH ? '提交到构建服务，并在下方查看实时日志' : 'tar 包根目录缺少 Dockerfile'}>
                <Button
                  disabled={
                    !cloudActive ||
                    (cloudDrafts.find((item) => item.id === draftId)?.latestBuild?.status !== 'building' &&
                      (!validation.ok || dockerfilePath !== DEFAULT_DOCKERFILE_PATH))
                  }
                  loading={buildSubmitting}
                  onClick={() =>
                    handleBuildClick(
                      draftId,
                      dockerfilePath,
                      cloudDrafts.find((item) => item.id === draftId)?.latestBuild,
                    )
                  }
                >
                  {cloudDrafts.find((item) => item.id === draftId)?.latestBuild?.status === 'building'
                    ? '查看日志'
                    : '构建镜像'}
                </Button>
              </Tooltip>
              <Button
                icon={<DownloadOutlined />}
                loading={downloading}
                onClick={() => void handleDownloadTar()}
              >
                下载 tar
              </Button>
              <Button
                type="primary"
                icon={<CloudUploadOutlined />}
                loading={cloudSyncing}
                disabled={!cloudActive}
                onClick={openSaveDraftModal}
              >
                保存草稿
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              本地构建：docker build -f {dockerfilePath} -t my-sandbox:{draftVersion.trim() || 'latest'} .
              {cloudActive
                ? ' 保存草稿会写入版本号并同步 OSS；列表操作与下方按钮一致。'
                : ' 配置云端后可将 Dockerfile 与文件保存到 OSS。'}
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 24 }}
        message="构建结果"
        description="构建成功后，镜像 tag 会写入沙箱镜像列表。列表里已有同一地址时不会重复添加。"
      />

      <Modal
        title={createKind === 'directory' ? '新建目录' : '新建文件'}
        open={addPathOpen}
        onOk={addContextEntry}
        onCancel={() => setAddPathOpen(false)}
        okText="创建"
        destroyOnClose
      >
        {createKind === 'directory' ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            会添加占位文件 <Typography.Text code>.gitkeep</Typography.Text>，以便在文件树与 tar 包中保留空目录。
          </Typography.Paragraph>
        ) : null}
        <Input
          placeholder={
            createKind === 'directory' ? '例如 certs 或 ssl/certs' : '例如 scripts/bootstrap.sh'
          }
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          onPressEnter={addContextEntry}
        />
      </Modal>

      <Modal
        title="保存草稿"
        open={saveDraftOpen}
        onOk={() => void confirmSaveDraft()}
        onCancel={() => setSaveDraftOpen(false)}
        confirmLoading={cloudSyncing}
        okText="保存"
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          为当前 Dockerfile 与构建上下文命名并记录版本，保存后写入 PostgreSQL 并同步 OSS。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Typography.Text>镜像名称</Typography.Text>
            <Input
              value={saveFormName}
              onChange={(event) => setSaveFormName(event.target.value)}
              placeholder="例如 team/python-data-sandbox"
              maxLength={120}
              showCount
            />
          </div>
          <div>
            <Typography.Text>版本</Typography.Text>
            <Input
              value={saveFormVersion}
              onChange={(event) => setSaveFormVersion(event.target.value)}
              placeholder="例如 1.0.0"
              maxLength={64}
            />
          </div>
          <div>
            <Typography.Text>备注</Typography.Text>
            <Input.TextArea
              value={saveFormRemark}
              onChange={(event) => setSaveFormRemark(event.target.value)}
              placeholder="可选：用途、变更说明、负责人等"
              maxLength={512}
              showCount
              rows={3}
            />
          </div>
        </Space>
      </Modal>

      <Modal
        title="构建镜像"
        open={buildOpen}
        onOk={() => void confirmBuild()}
        onCancel={() => setBuildOpen(false)}
        okText="开始构建"
        confirmLoading={buildSubmitting}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Text>镜像地址</Typography.Text>
            <Input
              addonBefore={BUILD_IMAGE_PREFIX}
              value={buildImageSuffix}
              onChange={(event) => setBuildImageSuffix(imageSuffixFromInput(event.target.value))}
              placeholder="app:1.0"
              maxLength={255}
            />
          </div>
          <div>
            <Typography.Text>架构</Typography.Text>
            <Radio.Group
              value={buildArch}
              onChange={(event) => setBuildArch(event.target.value as '1' | '2')}
            >
              <Radio value="1">amd64</Radio>
              <Radio value="2">arm64</Radio>
            </Radio.Group>
          </div>
        </Space>
      </Modal>

      <Drawer
        title="构建日志"
        open={logOpen}
        width={720}
        onClose={() => {
          closeBuildLogs();
          setLogOpen(false);
        }}
      >
        {logResult ? (
          <Alert
            style={{ marginBottom: 12 }}
            type={logResult.status === 'success' ? 'success' : logResult.status === 'cleaned' ? 'warning' : 'error'}
            showIcon
            message={buildResultText(logResult)}
          />
        ) : (
          <Alert style={{ marginBottom: 12 }} type="info" showIcon message="构建进行中。关闭页面不会取消构建。" />
        )}
        <pre
          ref={logViewRef}
          style={{
            margin: 0,
            maxHeight: 480,
            overflow: 'auto',
            padding: 12,
            background: '#0f1419',
            color: '#d6deeb',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {logLines.join('\n')}
        </pre>
      </Drawer>
    </div>
  );
}
