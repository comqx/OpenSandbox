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


def normalize_relative_path(raw: str) -> str | None:
    trimmed = raw.strip().replace("\\", "/")
    if not trimmed or trimmed.startswith("/"):
        return None
    parts = [part for part in trimmed.split("/") if part]
    normalized: list[str] = []
    for part in parts:
        if part == ".":
            continue
        if part == "..":
            return None
        normalized.append(part)
    if not normalized:
        return None
    return "/".join(normalized)
