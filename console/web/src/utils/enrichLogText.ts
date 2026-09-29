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

const ANSI_ESCAPE = /\x1b\[/;

const TIMESTAMP_SOURCE =
  String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?`;

const LEVEL_SOURCE = String.raw`\b(ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|PANIC|CRITICAL)\b`;

const UNIX_PATH_SOURCE = String.raw`(?:^|[\s"'(])(\/(?:[\w.@~-]+|\/)+[\w.@~-]*)`;

const KEYWORDS_SOURCE =
  String.raw`\b(failed|failure|error|exception|panic|starting|started|ready|listening|shutdown|timeout|denied|unauthorized|forbidden)\b`;

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';

function levelColor(level: string): string {
  const u = level.toUpperCase();
  if (u === 'ERROR' || u === 'ERR' || u === 'FATAL' || u === 'PANIC' || u === 'CRITICAL') {
    return RED;
  }
  if (u === 'WARN' || u === 'WARNING') return YELLOW;
  if (u === 'DEBUG' || u === 'TRACE') return BLUE;
  if (u === 'INFO') return GREEN;
  return RESET;
}

function keywordColor(word: string): string {
  const u = word.toLowerCase();
  if (u === 'failed' || u === 'failure' || u === 'error' || u === 'exception' || u === 'panic') {
    return RED;
  }
  if (u === 'denied' || u === 'unauthorized' || u === 'forbidden' || u === 'timeout') {
    return YELLOW;
  }
  if (u === 'starting' || u === 'started' || u === 'ready' || u === 'listening') {
    return GREEN;
  }
  return MAGENTA;
}

/** 为尚无 ANSI 的纯文本日志注入颜色，供 LazyLog 解析展示。 */
function colorizePlainLine(line: string): string {
  let out = line;

  out = out.replace(new RegExp(TIMESTAMP_SOURCE, 'g'), (m) => `${DIM}${m}${RESET}`);
  out = out.replace(/OpenSandbox/g, `${MAGENTA}OpenSandbox${RESET}`);
  out = out.replace(new RegExp(LEVEL_SOURCE, 'gi'), (m) => `${levelColor(m)}${m}${RESET}`);
  out = out.replace(new RegExp(KEYWORDS_SOURCE, 'gi'), (m) => `${keywordColor(m)}${m}${RESET}`);
  out = out.replace(new RegExp(UNIX_PATH_SOURCE, 'g'), (m, path: string) =>
    m.replace(path, `${CYAN}${path}${RESET}`),
  );

  return out;
}

/** 若内容已含 ANSI 则原样返回，否则按行着色。 */
export function enrichLogTextForDisplay(raw: string | null | undefined): string {
  const text = raw?.trim() ? raw : '(empty)';
  if (ANSI_ESCAPE.test(text)) return text;
  return text.split('\n').map(colorizePlainLine).join('\n');
}
