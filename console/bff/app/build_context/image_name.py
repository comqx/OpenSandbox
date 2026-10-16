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

import re
from typing import Any

_IMAGE_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,255}$")


def normalize_image_name(raw: Any) -> str:
    from app.build_context.service import BuildContextError

    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        raise BuildContextError("IMAGE_BUILD_INVALID", "镜像名称不能为空")
    if _IMAGE_NAME.fullmatch(text) is None or ".." in text:
        raise BuildContextError("IMAGE_BUILD_INVALID", "镜像名称不合法")
    return text


def normalize_basic_struct(raw: Any) -> str:
    from app.build_context.service import BuildContextError

    if not isinstance(raw, str) or raw not in ("1", "2"):
        raise BuildContextError("IMAGE_BUILD_INVALID", "架构类型只支持 1(amd64) 或 2(arm64)")
    return raw
