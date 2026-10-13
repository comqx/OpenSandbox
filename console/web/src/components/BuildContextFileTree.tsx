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
  CodeOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { TreeProps } from 'antd/es/tree';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import {
  buildContextTreeData,
  listBuildContextDirectoryKeys,
  resolveTreeDropMove,
  wrapBuildContextTreeRoot,
} from '../utils/buildContextTree';
import {
  SHELL_TREE_CSS,
  SHELL_TREE_PANEL,
  classifyShellEntry,
  shellLabelStyle,
  shellModeStyle,
  type ShellEntryPresentation,
} from '../utils/buildContextShellTheme';

const { DirectoryTree } = Tree;

function nodeLabel(node: DataNode, fallback: string): string {
  return typeof node.title === 'string' ? node.title : fallback;
}

function shellIcon(kind: ShellEntryPresentation['kind']): ReactNode {
  switch (kind) {
    case 'directory':
    case 'contextRoot':
      return <FolderOutlined />;
    case 'shellScript':
      return <CodeOutlined />;
    case 'python':
      return <CodeOutlined />;
    case 'cert':
      return <KeyOutlined />;
    case 'text':
    case 'nginx':
    case 'dockerfile':
    case 'dockerignore':
      return <FileTextOutlined />;
    default:
      return <FileOutlined />;
  }
}

function ShellTreeLabel({
  name,
  path,
  isDirectory,
  dockerfilePath,
}: {
  name: string;
  path: string;
  isDirectory: boolean;
  dockerfilePath: string;
}) {
  const presentation = classifyShellEntry(isDirectory ? path : path, isDirectory, dockerfilePath);
  return (
    <span title={path}>
      <span style={shellModeStyle(presentation)}>{presentation.mode}</span>
      <span style={shellLabelStyle(presentation)}>{name}</span>
    </span>
  );
}

function decorateTreeNodes(nodes: DataNode[], dockerfilePath: string): DataNode[] {
  return nodes.map((node) => {
    const key = String(node.key ?? '');
    if (key.startsWith('dir:')) {
      const isContextRoot = key === 'dir:__context_root__';
      const label = nodeLabel(node, key.replace(/^dir:/, ''));
      const presentation = classifyShellEntry(key, true, dockerfilePath);
      return {
        ...node,
        icon: <span style={{ color: presentation.color }}>{shellIcon(presentation.kind)}</span>,
        title: (
          <ShellTreeLabel
            name={label}
            path={isContextRoot ? 'build-context' : label}
            isDirectory
            dockerfilePath={dockerfilePath}
          />
        ),
        children: decorateTreeNodes(node.children ?? [], dockerfilePath),
      };
    }
    const path = key;
    const fileName = nodeLabel(node, path.split('/').pop() ?? path);
    const presentation = classifyShellEntry(path, false, dockerfilePath);
    return {
      ...node,
      isLeaf: true,
      icon: <span style={{ color: presentation.color }}>{shellIcon(presentation.kind)}</span>,
      title: (
        <ShellTreeLabel name={fileName} path={path} isDirectory={false} dockerfilePath={dockerfilePath} />
      ),
    };
  });
}

export type BuildContextFileTreeProps = {
  paths: string[];
  selectedPath: string;
  dockerfilePath: string;
  onSelectPath: (path: string) => void;
  onMoveFile?: (fromPath: string, toPath: string) => void;
};

export function BuildContextFileTree({
  paths,
  selectedPath,
  dockerfilePath,
  onSelectPath,
  onMoveFile,
}: BuildContextFileTreeProps) {
  const treeData = useMemo(() => {
    const built = wrapBuildContextTreeRoot(buildContextTreeData(paths));
    return decorateTreeNodes(built, dockerfilePath);
  }, [dockerfilePath, paths]);

  const [expandedKeys, setExpandedKeys] = useState<string[]>(() => listBuildContextDirectoryKeys(paths));

  useEffect(() => {
    setExpandedKeys(listBuildContextDirectoryKeys(paths));
  }, [paths]);

  const handleDrop: TreeProps['onDrop'] = (info) => {
    if (!onMoveFile) {
      return;
    }
    const fromKey = String(info.dragNode.key ?? '');
    if (fromKey.startsWith('dir:') || fromKey === dockerfilePath) {
      return;
    }
    const dropKey = String(info.node.key ?? '');
    const target = resolveTreeDropMove(fromKey, {
      dropKey,
      dropToGap: info.dropToGap,
      dropPosition: info.dropPosition,
    });
    if (target && target !== fromKey) {
      onMoveFile(fromKey, target);
    }
  };

  if (treeData.length === 0) {
    return <Typography.Text type="secondary">暂无文件</Typography.Text>;
  }

  return (
    <div className="build-context-shell-tree" style={SHELL_TREE_PANEL}>
      <style>{SHELL_TREE_CSS}</style>
      <DirectoryTree
        blockNode
        showLine
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys.map(String))}
        expandAction="doubleClick"
        allowDrop={() => true}
        draggable={
          onMoveFile
            ? {
                icon: false,
                nodeDraggable: (node) => {
                  const key = String(node.key ?? '');
                  return !key.startsWith('dir:') && key !== dockerfilePath;
                },
              }
            : false
        }
        selectedKeys={selectedPath ? [selectedPath] : []}
        treeData={treeData}
        onSelect={(keys) => {
          const key = keys[0];
          if (typeof key === 'string' && !key.startsWith('dir:')) {
            onSelectPath(key);
          }
        }}
        onDragEnter={(info) => {
          const key = String(info.node.key ?? '');
          if (key.startsWith('dir:')) {
            setExpandedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
          }
        }}
        onDrop={onMoveFile ? handleDrop : undefined}
      />
    </div>
  );
}
