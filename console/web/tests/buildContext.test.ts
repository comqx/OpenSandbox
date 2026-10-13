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
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  buildContextManifest,
  bytesToContextFile,
  contextFilesToByteMap,
  createDefaultContextFiles,
  normalizeRelativePath,
  validateBuildContext,
} from '../src/utils/buildContextModel.ts';
import { packBuildContextTar, packBuildContextTarGzSync } from '../src/utils/buildContextTar.ts';

test('normalizeRelativePath rejects traversal and absolute paths', () => {
  assert.equal(normalizeRelativePath('Dockerfile'), 'Dockerfile');
  assert.equal(normalizeRelativePath('scripts/run.sh'), 'scripts/run.sh');
  assert.equal(normalizeRelativePath('../secret'), null);
  assert.equal(normalizeRelativePath('/etc/passwd'), null);
  assert.equal(normalizeRelativePath('a/../b'), null);
});

test('validateBuildContext requires dockerfile path present', () => {
  const files = createDefaultContextFiles();
  const ok = validateBuildContext(files, 'Dockerfile');
  assert.equal(ok.ok, true);
  const bad = validateBuildContext([], 'Dockerfile');
  assert.equal(bad.ok, false);
});

test('manifest lists file sizes and dockerfile pointer', () => {
  const files = createDefaultContextFiles();
  const manifest = buildContextManifest(files, 'Dockerfile');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.dockerfile, 'Dockerfile');
  assert.ok(manifest.files.Dockerfile);
});

test('tar contains Dockerfile payload and gzip round-trips', () => {
  const files = contextFilesToByteMap(createDefaultContextFiles());
  const tar = packBuildContextTar(files, 1_700_000_000);
  const nameBytes = tar.slice(0, 100);
  const name = new TextDecoder().decode(nameBytes).replace(/\0/g, '');
  assert.equal(name, 'Dockerfile');
  const sizeOctal = new TextDecoder().decode(tar.slice(124, 136)).replace(/\0/g, '');
  const size = parseInt(sizeOctal, 8);
  assert.ok(size > 0);
  const payload = tar.slice(512, 512 + size);
  assert.match(new TextDecoder().decode(payload), /FROM python:3.12-slim/);

  const gz = packBuildContextTarGzSync(files, (input) => gzipSync(input), 1_700_000_000);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  const ungz = gunzipSync(gz);
  assert.equal(ungz.byteLength, tar.byteLength);
});

test('bytesToContextFile preserves binary as base64', () => {
  const raw = new Uint8Array([0, 255, 128]);
  const file = bytesToContextFile('bin/blob.dat', raw);
  assert.equal(file.encoding, 'base64');
  assert.equal(file.relativePath, 'bin/blob.dat');
});
