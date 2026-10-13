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

import { DeleteOutlined, DownloadOutlined, FileAddOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Row,
  Space,
  Tag,
  Tree,
  Typography,
  Upload,
  message,
  type UploadProps,
} from 'antd';
import { useCallback, useMemo, useState } from 'react';

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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SandboxImageBuildPage() {
  const [files, setFiles] = useState<ContextFile[]>(() => createDefaultContextFiles());
  const [dockerfilePath, setDockerfilePath] = useState(DEFAULT_DOCKERFILE_PATH);
  const [selectedPath, setSelectedPath] = useState<string>(DEFAULT_DOCKERFILE_PATH);
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [downloading, setDownloading] = useState(false);
  const pathList = useMemo(() => files.map((file) => file.relativePath), [files]);
  const treeData = useMemo(() => buildContextTreeData(pathList), [pathList]);

  const selectedFile = files.find((file) => file.relativePath === selectedPath);

  const validation = useMemo(() => validateBuildContext(files, dockerfilePath), [files, dockerfilePath]);

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

  const handleDownloadTar = async () => {
    if (!validation.ok) {
      message.error(validation.errors[0] ?? '构建上下文校验失败');
      return;
    }
    setDownloading(true);
    try {
      const byteMap = contextFilesToByteMap(files);
      const gz = await packBuildContextTarGz(byteMap);
      downloadBlob(new Blob([gz.buffer], { type: 'application/gzip' }), 'sandbox-build-context.tar.gz');
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
        阶段一：在浏览器内编辑 Docker 构建上下文并下载 tar.gz。远程构建与镜像入库将在后续版本接入。
      </Typography.Paragraph>

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
        description="远程集群构建、构建日志、写入沙箱镜像列表与 SDK 引用将在 Phase 2 对接 BFF / 构建服务。"
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
