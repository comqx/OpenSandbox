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

import { load } from 'js-yaml';

import type { SandboxImageCatalogInput } from '../api/types';

const LIST_FIELDS = ['scenarios', 'systemPackages', 'runtimePackages'] as const;
const ALLOWED_KEYS = new Set<string>(['displayName', 'imageUri', 'maintainer', ...LIST_FIELDS]);

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlList(items: string[] | undefined): string {
  const filled = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (filled.length === 0) return '  - ""';
  return filled.map((item) => `  - ${yamlScalar(item)}`).join('\n');
}

/** Key template with Chinese comments. Callers fill the values after each colon. */
export function imageCatalogYamlTemplate(values: Partial<SandboxImageCatalogInput> = {}): string {
  return [
    '# 名称。列表里展示给研发看的名字',
    `displayName: ${yamlScalar(values.displayName?.trim() ?? '')}`,
    '',
    '# 镜像地址。创建沙箱时使用的容器镜像',
    `imageUri: ${yamlScalar(values.imageUri?.trim() ?? '')}`,
    '',
    '# 使用场景。每行一项，空行可以删掉',
    'scenarios:',
    yamlList(values.scenarios),
    '',
    '# 系统包。镜像内预装的系统软件，每行一项',
    'systemPackages:',
    yamlList(values.systemPackages),
    '',
    '# 内置软件 / 语言生态。每行一项',
    'runtimePackages:',
    yamlList(values.runtimePackages),
    '',
    '# 来源。默认是当前登录身份，可改成团队或平台名称',
    `maintainer: ${yamlScalar(values.maintainer?.trim() ?? '')}`,
    '',
  ].join('\n');
}

function asText(value: unknown, field: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`${field} 需要是文本`);
}

function asList(value: unknown, field: string): string[] {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : null;
  if (!raw) throw new Error(`${field} 需要写成列表`);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = asText(item, field);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
  }
  return items;
}

export function parseImageCatalogYaml(text: string): SandboxImageCatalogInput {
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '格式不正确';
    throw new Error(`YAML 无法解析：${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('YAML 需要是一组字段');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`未知字段 ${key}`);
  }
  const displayName = asText(record.displayName, 'displayName');
  const imageUri = asText(record.imageUri, 'imageUri');
  if (!displayName) throw new Error('请填写 displayName');
  if (!imageUri) throw new Error('请填写 imageUri');
  if (/\s/.test(imageUri)) throw new Error('imageUri 不能包含空白字符');
  return {
    displayName,
    imageUri,
    scenarios: asList(record.scenarios, 'scenarios'),
    systemPackages: asList(record.systemPackages, 'systemPackages'),
    runtimePackages: asList(record.runtimePackages, 'runtimePackages'),
    maintainer: asText(record.maintainer, 'maintainer'),
  };
}
