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
import re
from collections.abc import AsyncIterator
from urllib.parse import quote

import httpx

_TASK_ID = re.compile(r"^[0-9a-fA-F]{32}$")
SUBMIT_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=None, pool=10.0)


class BuilderConnectionError(Exception):
    pass


class BuilderResponseError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def builder_base_url(raw: str) -> str:
    return raw.strip().rstrip("/")


def submit_request(base_url: str, tar: bytes, image_name: str, basic_struct: str) -> httpx.Request:
    return httpx.Request(
        "POST",
        f"{builder_base_url(base_url)}/api/v1/build-image",
        data={"imageName": image_name, "basicStruct": basic_struct},
        files={"file": ("context.tar", tar, "application/x-tar")},
    )


def parse_submit_body(status_code: int, body: object) -> str:
    if status_code == 200 and isinstance(body, dict):
        data = body.get("data")
        task_id = data.get("taskId") if isinstance(data, dict) else None
        if isinstance(task_id, str) and _TASK_ID.fullmatch(task_id):
            return task_id
        raise BuilderResponseError(502, "构建服务返回异常")
    message = ""
    code = None
    if isinstance(body, dict):
        message = str(body.get("message") or "")
        code = body.get("code")
    if status_code == 400 or code == 10103:
        raise BuilderResponseError(400, message or "参数错误")
    if status_code >= 500 or code == 10101:
        raise BuilderResponseError(502, message or "服务端错误")
    raise BuilderResponseError(502, "构建服务返回异常")


class BuilderClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = builder_base_url(base_url)

    async def submit(self, tar: bytes, image_name: str, basic_struct: str) -> str:
        request = submit_request(self.base_url, tar, image_name, basic_struct)
        try:
            async with httpx.AsyncClient(timeout=SUBMIT_TIMEOUT) as client:
                response = await client.send(request)
        except httpx.HTTPError as exc:
            raise BuilderConnectionError(str(exc)) from exc
        try:
            body = response.json()
        except json.JSONDecodeError:
            body = None
        return parse_submit_body(response.status_code, body)

    async def iter_logs(self, task_id: str) -> AsyncIterator[bytes]:
        if _TASK_ID.fullmatch(task_id) is None:
            raise BuilderConnectionError("invalid task id")
        url = f"{self.base_url}/api/v1/build-image/{quote(task_id, safe='')}/logs"
        timeout = httpx.Timeout(None, connect=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise BuilderConnectionError(f"status {response.status_code}")
                    async for chunk in response.aiter_bytes():
                        yield chunk
        except BuilderConnectionError:
            raise
        except httpx.HTTPError as exc:
            raise BuilderConnectionError(str(exc)) from exc
