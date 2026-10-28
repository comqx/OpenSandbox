# Copyright 2026 The OpenSandbox Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import json

_TERMINAL = {"success", "failed", "cleaned"}


def _take_event(buf: bytearray) -> tuple[bytes, int] | None:
    lf = buf.find(b"\n\n")
    crlf = buf.find(b"\r\n\r\n")
    if lf < 0 and crlf < 0:
        return None
    if crlf >= 0 and (lf < 0 or crlf < lf):
        return bytes(buf[:crlf]), crlf + 4
    return bytes(buf[:lf]), lf + 2


def parse_terminal_event(block: bytes) -> dict[str, str] | None:
    event_name = ""
    data_lines: list[bytes] = []
    for line in block.splitlines():
        if line.startswith(b"event:"):
            event_name = line[6:].strip().decode("utf-8", errors="replace")
        elif line.startswith(b"data:"):
            data_lines.append(line[5:].lstrip())
    if event_name == "log" or not data_lines:
        return None
    try:
        payload = json.loads(b"\n".join(data_lines))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    status = payload.get("status")
    if status not in _TERMINAL:
        return None
    return {
        "status": str(status),
        "imageName": str(payload.get("imageName") or ""),
        "message": str(payload.get("message") or ""),
    }


class SseTerminalSniffer:
    """Watch forwarded SSE bytes for the first final build result."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.terminal: dict[str, str] | None = None

    def feed(self, chunk: bytes) -> None:
        if self.terminal is not None:
            return
        self._buf.extend(chunk)
        while self.terminal is None:
            taken = _take_event(self._buf)
            if taken is None:
                return
            block, consumed = taken
            del self._buf[:consumed]
            parsed = parse_terminal_event(block)
            if parsed is not None:
                self.terminal = parsed
