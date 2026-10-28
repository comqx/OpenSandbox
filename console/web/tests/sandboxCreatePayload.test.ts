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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSandboxCreateBody,
  type SandboxCreateFormValues,
} from '../src/utils/sandboxCreatePayload.ts';

function imageForm(overrides: SandboxCreateFormValues = {}): SandboxCreateFormValues {
  return {
    source: 'image',
    imageUri: 'python:3.11',
    entrypoint: [{ value: 'python' }, { value: '/app/main.py' }],
    timeoutEnabled: true,
    timeout: 3600,
    limits: { cpu: '500m', memory: '512Mi' },
    ...overrides,
  };
}

test('image mode sends the developer create fields that are filled in', () => {
  const body = buildSandboxCreateBody(
    imageForm({
      registryUsername: 'user',
      registryPassword: 'secret',
      requestsEnabled: true,
      requests: { cpu: '250m', memory: '256Mi' },
      platformEnabled: true,
      platformOs: 'linux',
      platformArch: 'arm64',
      env: [{ key: 'LOG_LEVEL', value: 'info' }],
      metadata: [{ key: 'name', value: 'demo' }],
      preStartEnabled: true,
      preStartCommand: [{ value: 'sh' }, { value: '-c' }, { value: 'echo ready' }],
      preStartTimeout: 30,
      periodic: [
        {
          name: 'heartbeat',
          schedule: '@every 30s',
          command: [{ value: 'echo' }, { value: 'tick' }],
          timeoutSeconds: 10,
        },
      ],
      networkEnabled: true,
      defaultAction: 'deny',
      egress: [{ action: 'allow', target: '*.example.com' }],
      credentialProxyEnabled: true,
      secureAccess: true,
      volumes: [
        {
          name: 'work',
          mountPath: '/mnt/work',
          readOnly: true,
          subPath: 'data',
          backend: 'host',
          hostPath: '/data/opensandbox',
        },
      ],
      renewExtendSeconds: 600,
      extensions: [{ key: 'storage.id', value: 'vol-1' }],
    }),
  );

  assert.deepEqual(body, {
    image: { uri: 'python:3.11', auth: { username: 'user', password: 'secret' } },
    entrypoint: ['python', '/app/main.py'],
    timeout: 3600,
    resourceLimits: { cpu: '500m', memory: '512Mi' },
    resourceRequests: { cpu: '250m', memory: '256Mi' },
    platform: { os: 'linux', arch: 'arm64' },
    env: { LOG_LEVEL: 'info' },
    metadata: { name: 'demo' },
    lifecycle: {
      preStart: { command: ['sh', '-c', 'echo ready'], timeoutSeconds: 30 },
      periodic: [
        {
          name: 'heartbeat',
          schedule: '@every 30s',
          command: ['echo', 'tick'],
          timeoutSeconds: 10,
        },
      ],
    },
    networkPolicy: {
      defaultAction: 'deny',
      egress: [{ action: 'allow', target: '*.example.com' }],
    },
    credentialProxy: { enabled: true },
    secureAccess: true,
    volumes: [
      {
        name: 'work',
        mountPath: '/mnt/work',
        readOnly: true,
        subPath: 'data',
        host: { path: '/data/opensandbox' },
      },
    ],
    extensions: {
      'access.renew.extend.seconds': '600',
      'storage.id': 'vol-1',
    },
  });
});

test('disabling timeout sends null and omits untouched optional fields', () => {
  const body = buildSandboxCreateBody(
    imageForm({
      timeoutEnabled: false,
      requestsEnabled: false,
      requests: { cpu: '1' },
      platformEnabled: false,
      platformOs: 'linux',
      platformArch: 'amd64',
      networkEnabled: false,
      credentialProxyEnabled: false,
      secureAccess: false,
      preStartEnabled: false,
      preStartCommand: [{ value: 'echo' }],
    }),
  );

  assert.equal(body.timeout, null);
  assert.equal('resourceRequests' in body, false);
  assert.equal('platform' in body, false);
  assert.equal('networkPolicy' in body, false);
  assert.equal('credentialProxy' in body, false);
  assert.equal('secureAccess' in body, false);
  assert.equal('lifecycle' in body, false);
});

test('snapshot mode requires an id and resource limits, and entrypoint is optional', () => {
  const body = buildSandboxCreateBody({
    source: 'snapshot',
    snapshotId: ' snap-1 ',
    timeoutEnabled: true,
    timeout: 600,
    limits: { cpu: '1', memory: '1Gi', gpu: '1', extra: [{ key: 'disk', value: '10Gi' }] },
  });

  assert.deepEqual(body, {
    snapshotId: 'snap-1',
    timeout: 600,
    resourceLimits: { cpu: '1', memory: '1Gi', gpu: '1', disk: '10Gi' },
  });
});

test('template mode keeps only template, timeout, metadata, network policy, and extensions', () => {
  const body = buildSandboxCreateBody({
    source: 'template',
    templateId: 'tpl-1',
    timeoutEnabled: true,
    timeout: 900,
    imageUri: 'python:3.11',
    entrypoint: [{ value: 'python' }],
    limits: { cpu: '500m', memory: '512Mi' },
    env: [{ key: 'A', value: 'b' }],
    metadata: [{ key: 'team', value: 'ml' }],
    platformEnabled: true,
    platformOs: 'linux',
    platformArch: 'amd64',
    secureAccess: true,
    credentialProxyEnabled: true,
    preStartEnabled: true,
    preStartCommand: [{ value: 'echo' }],
    volumes: [{ name: 'work', mountPath: '/mnt', backend: 'host', hostPath: '/data' }],
    networkEnabled: true,
    defaultAction: 'allow',
    egress: [{ action: 'deny', target: 'example.com' }],
    extensions: [{ key: 'feature.flag', value: 'on' }],
  });

  assert.deepEqual(body, {
    templateId: 'tpl-1',
    timeout: 900,
    metadata: { team: 'ml' },
    networkPolicy: {
      defaultAction: 'allow',
      egress: [{ action: 'deny', target: 'example.com' }],
    },
    extensions: { 'feature.flag': 'on' },
  });
});

test('pool mode sends poolRef and optional runtime fields, and drops incompatible ones', () => {
  const body = buildSandboxCreateBody({
    source: 'pool',
    poolRef: ' my-pool ',
    imageUri: 'python:3.11',
    entrypoint: [{ value: 'tail' }, { value: '-f' }, { value: '/dev/null' }],
    timeoutEnabled: true,
    timeout: 1200,
    limits: { cpu: '500m', memory: '512Mi' },
    env: [{ key: 'MODE', value: 'batch' }],
    metadata: [{ key: 'job', value: 'nightly' }],
    secureAccess: true,
    networkEnabled: true,
    defaultAction: 'deny',
    credentialProxyEnabled: true,
    platformEnabled: true,
    platformOs: 'linux',
    platformArch: 'amd64',
    volumes: [{ name: 'work', mountPath: '/mnt', backend: 'host', hostPath: '/data' }],
    snapshotId: 'snap-1',
    renewExtendSeconds: 300,
  });

  assert.deepEqual(body, {
    image: { uri: 'python:3.11' },
    entrypoint: ['tail', '-f', '/dev/null'],
    timeout: 1200,
    resourceLimits: { cpu: '500m', memory: '512Mi' },
    env: { MODE: 'batch' },
    metadata: { job: 'nightly' },
    secureAccess: true,
    extensions: {
      poolRef: 'my-pool',
      'access.renew.extend.seconds': '300',
    },
  });
});

test('pvc and ossfs volumes map to the create request backends', () => {
  const body = buildSandboxCreateBody(
    imageForm({
      volumes: [
        {
          name: 'models',
          mountPath: '/mnt/models',
          backend: 'pvc',
          claimName: 'shared-models',
          createIfNotExists: false,
          deleteOnSandboxTermination: true,
          storageClass: 'fast',
          storage: '10Gi',
          accessModes: 'ReadWriteOnce, ReadWriteMany',
        },
        {
          name: 'bucket',
          mountPath: '/mnt/oss',
          backend: 'ossfs',
          bucket: 'my-bucket',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          ossVersion: '1.0',
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          ossOptions: 'allow_other\numask=022\n',
        },
      ],
    }),
  );

  assert.deepEqual(body.volumes, [
    {
      name: 'models',
      mountPath: '/mnt/models',
      pvc: {
        claimName: 'shared-models',
        createIfNotExists: false,
        deleteOnSandboxTermination: true,
        storageClass: 'fast',
        storage: '10Gi',
        accessModes: ['ReadWriteOnce', 'ReadWriteMany'],
      },
    },
    {
      name: 'bucket',
      mountPath: '/mnt/oss',
      ossfs: {
        bucket: 'my-bucket',
        endpoint: 'oss-cn-hangzhou.aliyuncs.com',
        version: '1.0',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        options: ['allow_other', 'umask=022'],
      },
    },
  ]);
});

test('rejects incomplete image, reserved env, credential proxy without policy, and bad renew seconds', () => {
  assert.throws(() => buildSandboxCreateBody(imageForm({ imageUri: '  ' })), /镜像/);
  assert.throws(() => buildSandboxCreateBody(imageForm({ entrypoint: [{ value: ' ' }] })), /entrypoint/);
  assert.throws(
    () => buildSandboxCreateBody(imageForm({ env: [{ key: 'OPENSANDBOX_LIFECYCLE', value: '1' }] })),
    /OPENSANDBOX_LIFECYCLE/,
  );
  assert.throws(
    () => buildSandboxCreateBody(imageForm({ credentialProxyEnabled: true, networkEnabled: false })),
    /网络策略/,
  );
  assert.throws(() => buildSandboxCreateBody(imageForm({ renewExtendSeconds: 10 })), /300/);
  assert.throws(
    () =>
      buildSandboxCreateBody({
        source: 'template',
        templateId: 'tpl-1',
        timeoutEnabled: false,
      }),
    /超时/,
  );
  assert.throws(
    () =>
      buildSandboxCreateBody({
        source: 'pool',
        poolRef: ' ',
      }),
    /资源池/,
  );
  assert.throws(
    () =>
      buildSandboxCreateBody(
        imageForm({
          volumes: [
            {
              name: 'bucket',
              mountPath: '/mnt/oss',
              backend: 'ossfs',
              bucket: 'my-bucket',
              endpoint: 'oss-cn-hangzhou.aliyuncs.com',
              accessKeyId: 'ak',
              accessKeySecret: 'sk',
              ossOptions: '-o allow_other',
            },
          ],
        }),
      ),
    /ossfs/,
  );
});
