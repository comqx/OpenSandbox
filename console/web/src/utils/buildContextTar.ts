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

function padOctal(value: number, width: number): string {
  const text = value.toString(8);
  if (text.length > width - 1) {
    throw new Error(`octal field overflow: ${value}`);
  }
  return text.padStart(width - 1, '0') + '\0';
}

function writeHeader(name: string, size: number, mtime: number): Uint8Array {
  if (name.length > 100) {
    throw new Error(`tar path too long: ${name}`);
  }
  const header = new Uint8Array(BLOCK);
  const view = new DataView(header.buffer);
  const encoder = new TextEncoder();

  const writeString = (offset: number, length: number, text: string) => {
    const bytes = encoder.encode(text);
    header.set(bytes.slice(0, length - 1), offset);
  };

  writeString(0, 100, name);
  writeString(100, 8, padOctal(0o644, 8));
  writeString(108, 8, padOctal(0, 8));
  writeString(116, 8, padOctal(0, 8));
  writeString(124, 12, padOctal(size, 12));
  writeString(136, 12, padOctal(mtime, 12));
  writeString(148, 8, '        ');
  view.setUint8(156, 0x30); // '0' regular file
  writeString(257, 6, 'ustar\0');
  writeString(263, 2, '00');

  let checksum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    checksum += header[i]!;
  }
  writeString(148, 8, padOctal(checksum, 8));
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
export function packBuildContextTar(files: Map<string, Uint8Array>, mtimeSec = 1_700_000_000): Uint8Array {
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

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
  throw new Error('CompressionStream is not available in this environment');
}

/** Gzip tar suitable for docker build context upload (Phase 1 browser download). */
export async function packBuildContextTarGz(
  files: Map<string, Uint8Array>,
  mtimeSec?: number,
): Promise<Uint8Array> {
  const tar = packBuildContextTar(files, mtimeSec);
  return gzipBytes(tar);
}

export function packBuildContextTarGzSync(
  files: Map<string, Uint8Array>,
  gzipFn: (input: Uint8Array) => Uint8Array,
  mtimeSec?: number,
): Uint8Array {
  const tar = packBuildContextTar(files, mtimeSec);
  return gzipFn(tar);
}
