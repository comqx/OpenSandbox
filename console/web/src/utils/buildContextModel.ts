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

export const BUILD_CONTEXT_VERSION = 1 as const;

export const BUILD_CONTEXT_LIMITS = {
  maxFiles: 256,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const;

export const DEFAULT_DOCKERFILE_PATH = 'Dockerfile';

export const DEFAULT_DOCKERFILE = `# Sandbox base image — edit before download or remote build (Phase 2).
FROM python:3.12-slim

WORKDIR /workspace

# RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*
`;

export type BuildContextEncoding = 'utf-8' | 'base64';

export type BuildContextFileRecord = {
  encoding: BuildContextEncoding;
  size: number;
};

export type BuildContextManifest = {
  version: typeof BUILD_CONTEXT_VERSION;
  dockerfile: string;
  files: Record<string, BuildContextFileRecord>;
};

export type ContextFile = {
  relativePath: string;
  encoding: BuildContextEncoding;
  /** UTF-8 text when encoding is utf-8; base64 payload when encoding is base64. */
  payload: string;
};

export type BuildContextValidationResult =
  | { ok: true; dockerfilePath: string }
  | { ok: false; errors: string[] };

/** Normalize user input to a safe POSIX relative path, or null when invalid. */
export function normalizeRelativePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/')) {
    return null;
  }
  const parts = trimmed.split('/').filter((part) => part.length > 0);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      return null;
    }
    normalized.push(part);
  }
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join('/');
}

export function contextFileBytes(file: ContextFile): Uint8Array {
  if (file.encoding === 'utf-8') {
    return new TextEncoder().encode(file.payload);
  }
  const binary = atob(file.payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToContextFile(relativePath: string, data: Uint8Array): ContextFile {
  const path = normalizeRelativePath(relativePath);
  if (!path) {
    throw new Error(`Invalid path: ${relativePath}`);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { relativePath: path, encoding: 'utf-8', payload: text };
  } catch {
    let binary = '';
    for (let i = 0; i < data.length; i += 1) {
      binary += String.fromCharCode(data[i]!);
    }
    return { relativePath: path, encoding: 'base64', payload: btoa(binary) };
  }
}

export function createDefaultContextFiles(): ContextFile[] {
  return [
    {
      relativePath: DEFAULT_DOCKERFILE_PATH,
      encoding: 'utf-8',
      payload: DEFAULT_DOCKERFILE,
    },
  ];
}

export function validateBuildContext(
  files: ContextFile[],
  dockerfilePathInput: string,
): BuildContextValidationResult {
  const errors: string[] = [];
  const dockerfilePath = normalizeRelativePath(dockerfilePathInput) ?? DEFAULT_DOCKERFILE_PATH;
  if (!normalizeRelativePath(dockerfilePathInput)) {
    errors.push('Dockerfile 路径无效，已回退为 Dockerfile。');
  }

  if (files.length > BUILD_CONTEXT_LIMITS.maxFiles) {
    errors.push(`文件数量超过上限 ${BUILD_CONTEXT_LIMITS.maxFiles}。`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const path = normalizeRelativePath(file.relativePath);
    if (!path) {
      errors.push(`路径无效：${file.relativePath}`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`路径重复：${path}`);
    }
    seen.add(path);

    const bytes = contextFileBytes(file);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > BUILD_CONTEXT_LIMITS.maxFileBytes) {
      errors.push(`文件过大（${path}）：${bytes.byteLength} 字节。`);
    }
  }

  if (totalBytes > BUILD_CONTEXT_LIMITS.maxTotalBytes) {
    errors.push(`构建上下文总大小超过 ${BUILD_CONTEXT_LIMITS.maxTotalBytes} 字节。`);
  }

  if (!seen.has(dockerfilePath)) {
    errors.push(`缺少 Dockerfile 文件：${dockerfilePath}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, dockerfilePath };
}

export function buildContextManifest(
  files: ContextFile[],
  dockerfilePath: string,
): BuildContextManifest {
  const manifestFiles: Record<string, BuildContextFileRecord> = {};
  for (const file of files) {
    const path = normalizeRelativePath(file.relativePath);
    if (!path) {
      continue;
    }
    const size = contextFileBytes(file).byteLength;
    manifestFiles[path] = { encoding: file.encoding, size };
  }
  return {
    version: BUILD_CONTEXT_VERSION,
    dockerfile: dockerfilePath,
    files: manifestFiles,
  };
}

export function contextFilesToByteMap(files: ContextFile[]): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const file of files) {
    const path = normalizeRelativePath(file.relativePath);
    if (!path) {
      continue;
    }
    map.set(path, contextFileBytes(file));
  }
  return map;
}
