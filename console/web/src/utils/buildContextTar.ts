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

const BLOCK = 512;

function writeOctalField(header: Uint8Array, offset: number, width: number, value: number) {
  const text = value.toString(8);
  if (text.length > width - 1) {
    throw new Error(`octal field overflow: ${value}`);
  }
  const start = offset + width - 1 - text.length;
  header.fill(0x30, offset, start);
  for (let i = 0; i < text.length; i += 1) {
    header[start + i] = text.charCodeAt(i)!;
  }
  header[offset + width - 1] = 0;
}

function writeNameField(header: Uint8Array, offset: number, width: number, name: string) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(name);
  if (bytes.length >= width) {
    throw new Error(`tar path too long: ${name}`);
  }
  header.set(bytes, offset);
}

function writeChecksum(header: Uint8Array) {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += header[i]!;
  }
  const text = sum.toString(8);
  for (let i = 0; i < text.length; i += 1) {
    header[148 + i] = text.charCodeAt(i)!;
  }
  header[148 + text.length] = 0;
  header.fill(0x20, 148 + text.length + 1, 156);
}

function writeHeader(name: string, size: number, mtime: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();

  writeNameField(header, 0, 100, name);
  writeOctalField(header, 100, 8, 0o644);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeOctalField(header, 124, 12, size);
  writeOctalField(header, 136, 12, mtime);
  header[156] = 0x30; // '0' regular file
  header.set(encoder.encode('ustar'), 257);
  header[257 + 5] = 0;
  header.set(encoder.encode('00'), 263);

  writeChecksum(header);
  return header;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Build a POSIX ustar tar archive (uncompressed). */
export function packBuildContextTar(
  files: Map<string, Uint8Array>,
  mtimeSec = Math.floor(Date.now() / 1000),
): Uint8Array {
  const sortedPaths = [...files.keys()].sort();
  const chunks: Uint8Array[] = [];

  for (const path of sortedPaths) {
    const data = files.get(path);
    if (!data) {
      continue;
    }
    chunks.push(writeHeader(path, data.byteLength, mtimeSec));
    chunks.push(data);
    const remainder = data.byteLength % BLOCK;
    if (remainder !== 0) {
      chunks.push(new Uint8Array(BLOCK - remainder));
    }
  }

  chunks.push(new Uint8Array(BLOCK * 2));
  return concatChunks(chunks);
}
