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

export type SourceKind = 'image' | 'snapshot' | 'template' | 'pool';

export type TextRow = { value?: string };
export type PairRow = { key?: string; value?: string };

export type ResourceFields = {
  cpu?: string;
  memory?: string;
  gpu?: string;
  extra?: PairRow[];
};

export type VolumeFields = {
  name?: string;
  mountPath?: string;
  readOnly?: boolean;
  subPath?: string;
  backend?: 'host' | 'pvc' | 'ossfs';
  hostPath?: string;
  claimName?: string;
  createIfNotExists?: boolean;
  deleteOnSandboxTermination?: boolean;
  storageClass?: string;
  storage?: string;
  accessModes?: string;
  bucket?: string;
  endpoint?: string;
  ossVersion?: '1.0' | '2.0';
  accessKeyId?: string;
  accessKeySecret?: string;
  ossOptions?: string;
};

export type PeriodicHookFields = {
  name?: string;
  schedule?: string;
  command?: TextRow[];
  timeoutSeconds?: number | null;
};

export type SandboxCreateFormValues = {
  source?: SourceKind;
  imageUri?: string;
  registryUsername?: string;
  registryPassword?: string;
  snapshotId?: string;
  templateId?: string;
  poolRef?: string;
  entrypoint?: TextRow[];
  timeoutEnabled?: boolean;
  timeout?: number | null;
  limits?: ResourceFields;
  requestsEnabled?: boolean;
  requests?: ResourceFields;
  platformEnabled?: boolean;
  platformOs?: 'linux' | 'windows';
  platformArch?: 'amd64' | 'arm64';
  env?: PairRow[];
  metadata?: PairRow[];
  preStartEnabled?: boolean;
  preStartCommand?: TextRow[];
  preStartTimeout?: number | null;
  periodic?: PeriodicHookFields[];
  networkEnabled?: boolean;
  defaultAction?: 'allow' | 'deny';
  egress?: { action?: 'allow' | 'deny'; target?: string }[];
  credentialProxyEnabled?: boolean;
  secureAccess?: boolean;
  volumes?: VolumeFields[];
  renewExtendSeconds?: number | null;
  extensions?: PairRow[];
};

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const HOST_PATH = /^(\/|[A-Za-z]:[\\/])/;
const STORAGE_SIZE = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const RESERVED_ENV = 'OPENSANDBOX_LIFECYCLE';
const RENEW_KEY = 'access.renew.extend.seconds';
const RENEW_MIN = 300;
const RENEW_MAX = 86400;

function fail(message: string): never {
  throw new Error(message);
}

function trimmed(value: string | undefined | null): string {
  return (value ?? '').trim();
}

function argv(rows: TextRow[] | undefined): string[] {
  return (rows ?? []).map((row) => row.value ?? '').filter((value) => value.trim().length > 0);
}

function pairs(rows: PairRow[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows ?? []) {
    const key = trimmed(row.key);
    if (!key) continue;
    out[key] = row.value ?? '';
  }
  return out;
}

function resources(fields: ResourceFields | undefined): Record<string, string> | undefined {
  if (!fields) return undefined;
  const out: Record<string, string> = {};
  for (const key of ['cpu', 'memory', 'gpu'] as const) {
    const value = trimmed(fields[key]);
    if (value) out[key] = value;
  }
  for (const [key, value] of Object.entries(pairs(fields.extra))) {
    const next = value.trim();
    if (next) out[key] = next;
  }
  return Object.keys(out).length ? out : undefined;
}

function imageOf(values: SandboxCreateFormValues): Record<string, unknown> {
  const uri = trimmed(values.imageUri);
  if (!uri) fail('请输入镜像 URI');
  const username = trimmed(values.registryUsername);
  const password = trimmed(values.registryPassword);
  if (!username && !password) return { uri };
  if (!username || !password) fail('私有镜像需要同时填写仓库用户名和密码');
  return { uri, auth: { username, password } };
}

function resolveTimeout(values: SandboxCreateFormValues, source: SourceKind): number | null | undefined {
  const disabled = values.timeoutEnabled === false;
  if (source === 'template' && (disabled || values.timeout === undefined || values.timeout === null)) {
    fail('模板模式必须设置超时（秒）');
  }
  if (disabled) return null;
  if (values.timeout === undefined || values.timeout === null) return undefined;
  if (!Number.isInteger(values.timeout) || values.timeout < 60) fail('超时至少为 60 秒');
  return values.timeout;
}

function renewSeconds(value: number): string {
  if (!Number.isInteger(value) || value < RENEW_MIN || value > RENEW_MAX) {
    fail(`访问续期秒数必须是 ${RENEW_MIN} 到 ${RENEW_MAX} 之间的整数`);
  }
  return String(value);
}

function extensionsOf(values: SandboxCreateFormValues, source: SourceKind): Record<string, string> | undefined {
  const out = pairs(values.extensions);
  const customPool = trimmed(out.poolRef);
  delete out.poolRef;
  const customRenew = out[RENEW_KEY];
  delete out[RENEW_KEY];

  if (source === 'pool') {
    const poolRef = trimmed(values.poolRef) || customPool;
    if (!poolRef) fail('请填写资源池名称');
    out.poolRef = poolRef;
  } else if (customPool) {
    fail('扩展参数不能包含 poolRef，请改用来源「资源池」');
  }

  if (values.renewExtendSeconds !== undefined && values.renewExtendSeconds !== null) {
    out[RENEW_KEY] = renewSeconds(values.renewExtendSeconds);
  } else if (customRenew !== undefined && trimmed(customRenew)) {
    const parsed = Number(trimmed(customRenew));
    out[RENEW_KEY] = renewSeconds(parsed);
  }

  return Object.keys(out).length ? out : undefined;
}

function networkPolicyOf(values: SandboxCreateFormValues): Record<string, unknown> | undefined {
  if (!values.networkEnabled) return undefined;
  const egress: { action: 'allow' | 'deny'; target: string }[] = [];
  for (const rule of values.egress ?? []) {
    const target = trimmed(rule.target);
    if (!target && !rule.action) continue;
    if (!target || (rule.action !== 'allow' && rule.action !== 'deny')) {
      fail('出站规则需要动作和域名');
    }
    egress.push({ action: rule.action, target });
  }
  const policy: Record<string, unknown> = {
    defaultAction: values.defaultAction === 'allow' ? 'allow' : 'deny',
  };
  if (egress.length) policy.egress = egress;
  return policy;
}

function lifecycleOf(values: SandboxCreateFormValues): Record<string, unknown> | undefined {
  const lifecycle: Record<string, unknown> = {};
  if (values.preStartEnabled) {
    const command = argv(values.preStartCommand);
    if (!command.length) fail('请填写 preStart 命令');
    const hook: Record<string, unknown> = { command };
    if (values.preStartTimeout !== undefined && values.preStartTimeout !== null) {
      if (!Number.isInteger(values.preStartTimeout) || values.preStartTimeout < 1 || values.preStartTimeout > 10800) {
        fail('preStart 超时必须是 1 到 10800 秒');
      }
      hook.timeoutSeconds = values.preStartTimeout;
    }
    lifecycle.preStart = hook;
  }

  const periodic = [];
  for (const hook of values.periodic ?? []) {
    const name = trimmed(hook.name);
    const schedule = trimmed(hook.schedule);
    const command = argv(hook.command);
    const hasTimeout = hook.timeoutSeconds !== undefined && hook.timeoutSeconds !== null;
    if (!name && !schedule && !command.length && !hasTimeout) continue;
    if (!name || !schedule || !command.length) fail('周期钩子需要名称、调度表达式和命令');
    const item: Record<string, unknown> = { name, schedule, command };
    if (hasTimeout) {
      const timeout = hook.timeoutSeconds as number;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
        fail('周期钩子超时必须是 1 到 300 秒');
      }
      item.timeoutSeconds = timeout;
    }
    periodic.push(item);
  }
  if (periodic.length) lifecycle.periodic = periodic;
  return Object.keys(lifecycle).length ? lifecycle : undefined;
}

function requireDnsLabel(value: string, label: string, maxLength: number): string {
  if (!DNS_LABEL.test(value) || value.length > maxLength) {
    fail(`${label}必须是小写 DNS 标签`);
  }
  return value;
}

function volumesOf(values: SandboxCreateFormValues): Record<string, unknown>[] | undefined {
  const volumes = [];
  const names = new Set<string>();
  for (const volume of values.volumes ?? []) {
    const name = trimmed(volume.name);
    const mountPath = trimmed(volume.mountPath);
    const backend = volume.backend;
    if (!name && !mountPath && !backend) continue;
    if (!name || !mountPath || !backend) fail('存储卷需要名称、挂载路径和后端');
    requireDnsLabel(name, '卷名称', 63);
    if (names.has(name)) fail(`卷名称 ${name} 重复`);
    names.add(name);
    if (!mountPath.startsWith('/')) fail('挂载路径必须以 / 开头');

    const entry: Record<string, unknown> = { name, mountPath };
    if (volume.readOnly) entry.readOnly = true;
    const subPath = trimmed(volume.subPath);
    if (subPath) {
      if (subPath.startsWith('/') || subPath.split('/').includes('..')) {
        fail('subPath 必须是不含 .. 的相对路径');
      }
      entry.subPath = subPath;
    }

    if (backend === 'host') {
      const path = trimmed(volume.hostPath);
      if (!HOST_PATH.test(path)) fail('主机路径必须是绝对路径');
      entry.host = { path };
    } else if (backend === 'pvc') {
      const claimName = requireDnsLabel(trimmed(volume.claimName), 'PVC 名称', 253);
      const pvc: Record<string, unknown> = { claimName };
      if (volume.createIfNotExists === false) pvc.createIfNotExists = false;
      if (volume.deleteOnSandboxTermination) pvc.deleteOnSandboxTermination = true;
      const storageClass = trimmed(volume.storageClass);
      if (storageClass) pvc.storageClass = storageClass;
      const storage = trimmed(volume.storage);
      if (storage) {
        if (!STORAGE_SIZE.test(storage)) fail('PVC 容量格式无效，例如 10Gi');
        pvc.storage = storage;
      }
      const accessModes = (volume.accessModes ?? '')
        .split(',')
        .map((mode) => mode.trim())
        .filter(Boolean);
      if (accessModes.length) pvc.accessModes = accessModes;
      entry.pvc = pvc;
    } else if (backend === 'ossfs') {
      const bucket = trimmed(volume.bucket);
      const endpoint = trimmed(volume.endpoint);
      const accessKeyId = trimmed(volume.accessKeyId);
      const accessKeySecret = trimmed(volume.accessKeySecret);
      if (bucket.length < 3 || bucket.length > 63) fail('OSS bucket 名称长度必须在 3 到 63 之间');
      if (!endpoint || !accessKeyId || !accessKeySecret) fail('OSS 卷需要 endpoint 和访问密钥');
      const options = (volume.ossOptions ?? '')
        .split('\n')
        .map((option) => option.trim())
        .filter(Boolean);
      if (options.some((option) => option.startsWith('-'))) {
        fail('ossfs 挂载选项不要以 - 开头，请填写原始参数');
      }
      const ossfs: Record<string, unknown> = { bucket, endpoint, accessKeyId, accessKeySecret };
      if (volume.ossVersion) ossfs.version = volume.ossVersion;
      if (options.length) ossfs.options = options;
      entry.ossfs = ossfs;
    } else {
      fail('存储卷后端无效');
    }
    volumes.push(entry);
  }
  return volumes.length ? volumes : undefined;
}

export function buildSandboxCreateBody(values: SandboxCreateFormValues): Record<string, unknown> {
  const source = values.source;
  if (source !== 'image' && source !== 'snapshot' && source !== 'template' && source !== 'pool') {
    fail('请选择创建来源');
  }

  const body: Record<string, unknown> = {};
  if (source === 'image') {
    body.image = imageOf(values);
    const entrypoint = argv(values.entrypoint);
    if (!entrypoint.length) fail('请填写 entrypoint');
    body.entrypoint = entrypoint;
  } else if (source === 'snapshot') {
    const snapshotId = trimmed(values.snapshotId);
    if (!snapshotId) fail('请填写快照 ID');
    body.snapshotId = snapshotId;
    const entrypoint = argv(values.entrypoint);
    if (entrypoint.length) body.entrypoint = entrypoint;
  } else if (source === 'template') {
    const templateId = trimmed(values.templateId);
    if (!templateId) fail('请填写模板 ID');
    body.templateId = templateId;
  } else {
    const imageUri = trimmed(values.imageUri);
    if (imageUri) body.image = imageOf(values);
    const entrypoint = argv(values.entrypoint);
    if (entrypoint.length) body.entrypoint = entrypoint;
  }

  const timeout = resolveTimeout(values, source);
  if (timeout !== undefined) body.timeout = timeout;

  const limits = resources(values.limits);
  if (source === 'image' || source === 'snapshot') {
    if (!limits) fail('请填写资源上限');
    body.resourceLimits = limits;
  } else if (source === 'pool' && limits) {
    body.resourceLimits = limits;
  }

  if (values.requestsEnabled && source !== 'template') {
    const requests = resources(values.requests);
    if (requests) body.resourceRequests = requests;
  }

  if (values.platformEnabled && (source === 'image' || source === 'snapshot')) {
    if (!values.platformOs || !values.platformArch) fail('请同时选择操作系统和 CPU 架构');
    body.platform = { os: values.platformOs, arch: values.platformArch };
  }

  if (source !== 'template') {
    const env = pairs(values.env);
    if (Object.prototype.hasOwnProperty.call(env, RESERVED_ENV)) {
      fail(`环境变量 ${RESERVED_ENV} 由生命周期字段保留，不能手动设置`);
    }
    if (Object.keys(env).length) body.env = env;
  }

  const metadata = pairs(values.metadata);
  if (Object.keys(metadata).length) body.metadata = metadata;

  if (source === 'image' || source === 'snapshot') {
    const lifecycle = lifecycleOf(values);
    if (lifecycle) body.lifecycle = lifecycle;
  }

  if (source !== 'pool') {
    const networkPolicy = networkPolicyOf(values);
    if (networkPolicy) body.networkPolicy = networkPolicy;
  }

  if ((source === 'image' || source === 'snapshot') && values.credentialProxyEnabled) {
    if (!body.networkPolicy) fail('开启凭据代理前需要先配置出站网络策略');
    body.credentialProxy = { enabled: true };
  }

  if (values.secureAccess && source !== 'template') body.secureAccess = true;

  if (source === 'image' || source === 'snapshot') {
    const volumes = volumesOf(values);
    if (volumes) body.volumes = volumes;
  }

  const extensions = extensionsOf(values, source);
  if (extensions) body.extensions = extensions;

  return body;
}
