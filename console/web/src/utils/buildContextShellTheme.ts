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

import type { CSSProperties } from 'react';

export const SHELL_TREE_PANEL: CSSProperties = {
  background: '#0c0c0c',
  border: '1px solid #3a3a3a',
  borderRadius: 6,
  padding: '8px 6px',
  maxHeight: 420,
  overflow: 'auto',
};

export type ShellEntryKind =
  | 'contextRoot'
  | 'directory'
  | 'dockerfile'
  | 'shellScript'
  | 'python'
  | 'nginx'
  | 'cert'
  | 'dockerignore'
  | 'gitkeep'
  | 'text'
  | 'file';

export type ShellEntryPresentation = {
  kind: ShellEntryKind;
  color: string;
  mode: string;
  fontWeight: number;
};

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
};

export function shellLabelStyle(presentation: ShellEntryPresentation): CSSProperties {
  return {
    ...MONO,
    color: presentation.color,
    fontWeight: presentation.fontWeight,
  };
}

export function shellModeStyle(_presentation: ShellEntryPresentation): CSSProperties {
  return {
    ...MONO,
    color: '#6e7681',
    marginInlineEnd: 6,
    userSelect: 'none',
  };
}

export function classifyShellEntry(
  path: string,
  isDirectory: boolean,
  dockerfilePath: string,
): ShellEntryPresentation {
  if (isDirectory) {
    const isRoot = path === 'dir:__context_root__' || path === 'build-context';
    return {
      kind: isRoot ? 'contextRoot' : 'directory',
      color: isRoot ? '#79c0ff' : '#58a6ff',
      mode: isRoot ? 'drwx' : 'drwx',
      fontWeight: isRoot ? 700 : 600,
    };
  }

  const base = path.split('/').pop() ?? path;
  const lower = base.toLowerCase();
  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : '';

  if (path === dockerfilePath || lower === 'dockerfile') {
    return { kind: 'dockerfile', color: '#ffa657', mode: '-rw-', fontWeight: 700 };
  }
  if (lower === '.gitkeep' || lower.endsWith('.gitkeep')) {
    return { kind: 'gitkeep', color: '#6e7681', mode: '-rw-', fontWeight: 400 };
  }
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
    return { kind: 'shellScript', color: '#3fb950', mode: 'rwx', fontWeight: 600 };
  }
  if (ext === 'py' || ext === 'pyw' || ext === 'pyi') {
    return { kind: 'python', color: '#d2a8ff', mode: '-rw-', fontWeight: 500 };
  }
  if (lower.includes('nginx') || ext === 'conf') {
    return { kind: 'nginx', color: '#79c0ff', mode: '-rw-', fontWeight: 500 };
  }
  if (['csr', 'crt', 'pem', 'key', 'cer', 'p12', 'pfx'].includes(ext)) {
    return { kind: 'cert', color: '#f778ba', mode: '-rw-', fontWeight: 500 };
  }
  if (lower === '.dockerignore') {
    return { kind: 'dockerignore', color: '#8b949e', mode: '-rw-', fontWeight: 400 };
  }
  if (['md', 'txt', 'yaml', 'yml', 'json', 'toml', 'env'].includes(ext)) {
    return { kind: 'text', color: '#c9d1d9', mode: '-rw-', fontWeight: 400 };
  }
  return { kind: 'file', color: '#e6edf3', mode: '-rw-', fontWeight: 400 };
}

export const SHELL_TREE_CSS = `
.build-context-shell-tree .ant-tree {
  background: transparent !important;
  color: #c9d1d9;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.build-context-shell-tree .ant-tree-list-holder-inner {
  background: transparent !important;
}
.build-context-shell-tree .ant-tree-treenode {
  padding-block: 1px;
}
.build-context-shell-tree .ant-tree-node-content-wrapper {
  border-radius: 4px;
  transition: background 0.12s ease;
}
.build-context-shell-tree .ant-tree-node-content-wrapper:hover {
  background: #1f1f1f !important;
}
.build-context-shell-tree .ant-tree-node-selected {
  background: #2d333b !important;
  box-shadow: inset 2px 0 0 #58a6ff;
}
.build-context-shell-tree .ant-tree-switcher,
.build-context-shell-tree .ant-tree-iconEle {
  color: #8b949e !important;
}
.build-context-shell-tree .ant-tree-indent-unit::before {
  border-inline-end-color: #3a3a3a !important;
}
.build-context-shell-tree .ant-tree-show-line .ant-tree-indent-unit::before,
.build-context-shell-tree .ant-tree-show-line .ant-tree-switcher-line-icon {
  color: #3a3a3a !important;
}
.build-context-shell-tree .ant-tree-draggable-icon {
  opacity: 0.35;
}
`;
