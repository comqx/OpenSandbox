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

export type BuildLogEntry =
  | { kind: 'log'; line: string }
  | { kind: 'result'; status: string; imageName: string; message: string };

const TERMINAL = new Set(['success', 'failed', 'cleaned']);

export function parseBuildLogData(raw: string): BuildLogEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.status === 'string' && TERMINAL.has(record.status)) {
    return {
      kind: 'result',
      status: record.status,
      imageName: typeof record.imageName === 'string' ? record.imageName : '',
      message: typeof record.message === 'string' ? record.message : '',
    };
  }
  if (typeof record.line === 'string') {
    return { kind: 'log', line: record.line };
  }
  return null;
}
