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

import asyncio
import io
import tarfile
from datetime import datetime

import pytest
from psycopg.errors import UniqueViolation

from app.build_context import service as build_service
from app.build_context import store as build_store
from app.build_context.store import _iso_timestamp
from app.build_context.builder_client import (
    SUBMIT_TIMEOUT,
    BuilderConnectionError,
    BuilderResponseError,
    parse_submit_body,
    submit_request,
)
from app.build_context.image_name import normalize_basic_struct, normalize_image_name
from app.build_context.service import BuildContextError
from app.build_context.sse import SseTerminalSniffer
from app.config import Settings

TASK_ID = "ab" * 16


def _settings(**overrides: object) -> Settings:
    base = {
        "tenants_toml_path": "tenants.toml",
        "bff_session_secret": "x" * 32,
        "bff_admin_token": "token",
        "bff_history_enabled": True,
        "bff_image_build_enabled": True,
        "bff_image_build_oss_endpoint": "https://oss.example.com",
        "bff_image_build_oss_bucket": "bucket",
        "bff_image_build_oss_access_key_id": "id",
        "bff_image_build_oss_access_key_secret": "secret",
        "bff_image_builder_base_url": "http://builder.internal:8000/",
    }
    base.update(overrides)
    return Settings(**base)


def test_naive_timestamp_uses_utc():
    assert _iso_timestamp(datetime(2026, 10, 16, 1, 2, 3)) == "2026-10-16T01:02:03+00:00"


def test_image_name_rules():
    assert normalize_image_name("  hub.example.com/ns/app:1.0 ") == "hub.example.com/ns/app:1.0"
    with pytest.raises(BuildContextError) as empty:
        normalize_image_name("   ")
    assert empty.value.message == "镜像名称不能为空"
    with pytest.raises(BuildContextError) as bad:
        normalize_image_name("app latest")
    assert bad.value.message == "镜像名称不合法"
    with pytest.raises(BuildContextError) as dots:
        normalize_image_name("ns/app/../evil:1")
    assert dots.value.message == "镜像名称不合法"


def test_basic_struct_rules():
    assert normalize_basic_struct("1") == "1"
    assert normalize_basic_struct("2") == "2"
    with pytest.raises(BuildContextError) as exc:
        normalize_basic_struct(1)
    assert exc.value.message == "架构类型只支持 1(amd64) 或 2(arm64)"


def test_submit_request_uses_uncompressed_tar_fields():
    request = submit_request("http://builder.internal:8000/", b"tar-bytes", "app:1", "2")
    body = request.read()
    assert request.url.path == "/api/v1/build-image"
    assert b'name="file"' in body
    assert b'name="imageName"' in body
    assert b'name="basicStruct"' in body
    assert b"tar-bytes" in body
    assert b"app:1" in body
    assert b"\r\n2\r\n" in body or b"\n2\n" in body


def test_parse_submit_body_maps_builder_codes():
    assert parse_submit_body(200, {"data": {"taskId": TASK_ID}}) == TASK_ID
    with pytest.raises(BuilderResponseError) as invalid:
        parse_submit_body(400, {"code": 10103, "message": "缺少 tar 包，请使用 file 字段上传"})
    assert invalid.value.status_code == 400
    assert invalid.value.message == "缺少 tar 包，请使用 file 字段上传"
    with pytest.raises(BuilderResponseError) as upstream:
        parse_submit_body(500, {"code": 10101, "message": "amd64 docker client 未初始化"})
    assert upstream.value.status_code == 502


def test_pack_tar_is_uncompressed_and_contains_root_dockerfile():
    blob = build_service.pack_context_tar({"Dockerfile": b"FROM alpine\n", "app.txt": b"hi"})
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as tar:
        assert tar.getnames() == ["Dockerfile", "app.txt"]
        assert tar.extractfile("Dockerfile").read() == b"FROM alpine\n"


def test_sse_sniffer_ignores_log_events_and_keeps_first_terminal():
    sniffer = SseTerminalSniffer()
    sniffer.feed(b'event: log\ndata: {"line":"Step 1"}\n\n')
    assert sniffer.terminal is None
    sniffer.feed(b'data: {"status":"success","imageName":"app:1","message":""}\n\n')
    assert sniffer.terminal == {"status": "success", "imageName": "app:1", "message": ""}
    sniffer.feed(b'data: {"status":"cleaned","imageName":"","message":"\xe6\x9e\x84\xe5\xbb\xba\xe6\x97\xa5\xe5\xbf\x97\xe5\xb7\xb2\xe6\xb8\x85\xe7\x90\x86"}\n\n')
    assert sniffer.terminal["status"] == "success"


def test_sse_sniffer_handles_split_chunks():
    sniffer = SseTerminalSniffer()
    sniffer.feed(b'data: {"status":"fai')
    assert sniffer.terminal is None
    sniffer.feed(b'led","imageName":"app:1","message":"\xe6\x8b\x89\xe5\x8f\x96\xe5\x9f\xba\xe7\xa1\x80\xe9\x95\x9c\xe5\x83\x8f\xe5\xa4\xb1\xe8\xb4\xa5"}\n\n')
    assert sniffer.terminal["status"] == "failed"
    assert sniffer.terminal["message"] == "拉取基础镜像失败"


class _Builder:
    def __init__(self) -> None:
        self.submitted: tuple[bytes, str, str] | None = None
        self.error: Exception | None = None
        self.logs = [
            b'event: log\ndata: {"line":"Step 1"}\n\n',
            b'data: {"status":"success","imageName":"hub.example.com/ns/app:1.0","message":""}\n\n',
        ]
        self.raise_logs = False

    async def submit(self, tar: bytes, image_name: str, basic_struct: str) -> str:
        self.submitted = (tar, image_name, basic_struct)
        if self.error:
            raise self.error
        return TASK_ID

    async def iter_logs(self, task_id: str):
        del task_id
        if self.raise_logs:
            raise BuilderConnectionError("down")
        for chunk in self.logs:
            yield chunk


def _context(**overrides: object) -> dict:
    item = {
        "id": "ctx-1",
        "tenantId": "acme",
        "dockerfilePath": "Dockerfile",
        "manifest": {"files": {"Dockerfile": {"ossKey": "k"}}},
    }
    item.update(overrides)
    return item


def _enable(monkeypatch: pytest.MonkeyPatch, builder: _Builder) -> Settings:
    monkeypatch.setattr(build_service, "history_pool_available", lambda: True)
    monkeypatch.setattr(build_service, "oss_settings", lambda _settings: ("e", "b", "p", "id", "secret"))
    monkeypatch.setattr(build_service, "BuilderClient", lambda _base: builder)
    monkeypatch.setattr(build_store, "find_building_job", lambda *_args: None)
    monkeypatch.setattr(build_store, "insert_job", lambda **_kwargs: {"taskId": _kwargs["task_id"], "status": "building"})
    monkeypatch.setattr(build_store, "assign_builder_task", lambda **_kwargs: True)
    monkeypatch.setattr(build_store, "release_building_job", lambda **_kwargs: None)
    monkeypatch.setattr(
        build_service,
        "assemble_and_store_tar",
        lambda *_args, **_kwargs: (b"tar-bytes", "digest"),
    )
    return _settings()


def test_submit_posts_tar_and_stores_task(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    stored: dict = {}
    assigned: dict = {}

    def insert_job(**kwargs):
        stored.update(kwargs)
        return {"taskId": kwargs["task_id"]}

    def assign_builder_task(**kwargs):
        assigned.update(kwargs)
        return True

    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())
    monkeypatch.setattr(build_store, "insert_job", insert_job)
    monkeypatch.setattr(build_store, "assign_builder_task", assign_builder_task)

    result = asyncio.run(
        build_service.submit_build(
            settings,
            "acme",
            "ctx-1",
            {"imageName": " hub.example.com/ns/app:1.0 ", "basicStruct": "1"},
            "alice",
        )
    )

    assert result["taskId"] == TASK_ID
    assert result["status"] == "building"
    assert result["imageName"] == "hub.example.com/ns/app:1.0"
    assert builder.submitted == (b"tar-bytes", "hub.example.com/ns/app:1.0", "1")
    assert stored["status"] == "building"
    assert stored["tar_sha256"] == ""
    assert assigned == {
        "reserved_task_id": stored["task_id"],
        "task_id": TASK_ID,
        "tar_sha256": "digest",
    }


def test_submit_rejects_dockerfile_not_at_root(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(
        build_store,
        "get_context",
        lambda *_args: _context(dockerfilePath="docker/Dockerfile"),
    )
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings,
                "acme",
                "ctx-1",
                {"imageName": "app:1", "basicStruct": "1"},
                "alice",
            )
        )
    assert exc.value.message == "tar 包根目录缺少 Dockerfile"
    assert builder.submitted is None


def test_submit_maps_builder_errors(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    builder.error = BuilderResponseError(400, "镜像名称不合法")
    released: list[str] = []
    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())
    monkeypatch.setattr(
        build_store,
        "release_building_job",
        lambda **kwargs: released.append(kwargs["task_id"]),
    )
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "1"}, "alice"
            )
        )
    assert exc.value.status_code == 400
    assert exc.value.code == "IMAGE_BUILD_INVALID"
    assert exc.value.message == "镜像名称不合法"
    assert released


def test_submit_maps_upstream_failure(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    builder.error = BuilderResponseError(502, "arm64 docker client 未初始化")
    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "2"}, "alice"
            )
        )
    assert exc.value.status_code == 502
    assert exc.value.code == "IMAGE_BUILD_UPSTREAM"
    assert exc.value.message == "arm64 docker client 未初始化"


def test_submit_conflict_does_not_call_builder(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())
    monkeypatch.setattr(build_store, "find_building_job", lambda *_args: {"taskId": TASK_ID, "status": "building"})
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "1"}, "alice"
            )
        )
    assert exc.value.status_code == 409
    assert exc.value.code == "IMAGE_BUILD_IN_PROGRESS"
    assert builder.submitted is None


def test_submit_unique_index_is_conflict(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    settings = _enable(monkeypatch, builder)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())

    def insert_job(**_kwargs):
        raise UniqueViolation()

    monkeypatch.setattr(build_store, "insert_job", insert_job)
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "1"}, "alice"
            )
        )
    assert exc.value.status_code == 409
    assert builder.submitted is None


def test_submit_requires_builder_url(monkeypatch: pytest.MonkeyPatch):
    settings = _enable(monkeypatch, _Builder())
    settings = _settings(bff_image_builder_base_url="")
    monkeypatch.setattr(build_service, "history_pool_available", lambda: True)
    monkeypatch.setattr(build_service, "oss_settings", lambda _s: ("e", "b", "p", "id", "secret"))
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "1"}, "alice"
            )
        )
    assert exc.value.status_code == 503
    assert exc.value.code == "IMAGE_BUILDER_NOT_CONFIGURED"


def test_register_built_image_uses_draft_name_and_keeps_existing_uri(monkeypatch: pytest.MonkeyPatch):
    from app.image_catalog import ImageCatalogError

    created: list[dict] = []

    def create_image(body, actor):
        created.append({"body": body, "actor": actor})
        if body["imageUri"] == "repo/app:dup":
            raise ImageCatalogError("DUPLICATE_IMAGE", "该镜像地址已在目录中", 409)
        return {"id": "img-1"}

    monkeypatch.setattr(
        build_store,
        "get_context",
        lambda tenant_id, context_id: {"displayName": "客户镜像"},
    )
    monkeypatch.setattr(
        build_store,
        "get_job",
        lambda tenant_id, context_id, task_id: {"submittedBy": "acme"},
    )
    monkeypatch.setattr("app.image_catalog.create_image", create_image)
    build_service.register_built_image("acme", "ctx-1", TASK_ID, " repo/app:1 ")
    build_service.register_built_image("acme", "ctx-1", TASK_ID, "repo/app:dup")
    assert created == [
        {
            "body": {
                "displayName": "客户镜像",
                "imageUri": "repo/app:1",
                "scenarios": [],
                "systemPackages": [],
                "runtimePackages": [],
                "maintainer": "acme",
            },
            "actor": "acme",
        },
        {
            "body": {
                "displayName": "客户镜像",
                "imageUri": "repo/app:dup",
                "scenarios": [],
                "systemPackages": [],
                "runtimePackages": [],
                "maintainer": "acme",
            },
            "actor": "acme",
        },
    ]


def test_log_stream_updates_building_job_once(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    updates: list[dict] = []

    def finish_job_if_building(**kwargs):
        updates.append(kwargs)
        return True

    monkeypatch.setattr(build_store, "finish_job_if_building", finish_job_if_building)
    monkeypatch.setattr(build_service, "register_built_image", lambda *_args: None)
    chunks = asyncio.run(
        _collect(
            build_service.iter_build_log(
                builder,
                tenant_id="acme",
                context_id="ctx-1",
                task_id=TASK_ID,
                job_status="building",
            )
        )
    )
    assert b"event: log" in b"".join(chunks)
    assert b'"status":"success"' in b"".join(chunks)
    assert updates == [
        {
            "tenant_id": "acme",
            "context_id": "ctx-1",
            "task_id": TASK_ID,
            "status": "success",
            "message": "",
        }
    ]


def test_log_stream_does_not_overwrite_finished_job(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    called = {"n": 0}

    def finish_job_if_building(**_kwargs):
        called["n"] += 1
        return False

    monkeypatch.setattr(build_store, "finish_job_if_building", finish_job_if_building)
    asyncio.run(
        _collect(
            build_service.iter_build_log(
                builder,
                tenant_id="acme",
                context_id="ctx-1",
                task_id=TASK_ID,
                job_status="success",
            )
        )
    )
    assert called["n"] == 0


def test_catalog_failure_keeps_job_building_for_retry(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    called = {"n": 0}

    def register_built_image(*_args):
        raise RuntimeError("catalog down")

    monkeypatch.setattr(build_service, "register_built_image", register_built_image)
    monkeypatch.setattr(build_store, "finish_job_if_building", lambda **_kwargs: called.__setitem__("n", 1))
    chunks = asyncio.run(
        _collect(
            build_service.iter_build_log(
                builder,
                tenant_id="acme",
                context_id="ctx-1",
                task_id=TASK_ID,
                job_status="building",
            )
        )
    )
    assert b'"status":"success"' in b"".join(chunks)
    assert called["n"] == 0


def test_log_stream_still_forwards_result_when_job_update_fails(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()

    def finish_job_if_building(**_kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(build_store, "finish_job_if_building", finish_job_if_building)
    monkeypatch.setattr(build_service, "register_built_image", lambda *_args: None)
    chunks = asyncio.run(
        _collect(
            build_service.iter_build_log(
                builder,
                tenant_id="acme",
                context_id="ctx-1",
                task_id=TASK_ID,
                job_status="building",
            )
        )
    )
    assert b'"status":"success"' in b"".join(chunks)


def test_submit_timeout_keeps_write_budget():
    assert SUBMIT_TIMEOUT.connect == 10.0
    assert SUBMIT_TIMEOUT.read == 60.0
    assert SUBMIT_TIMEOUT.write is None


def test_log_connection_failure_leaves_job(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    builder.raise_logs = True
    called = {"n": 0}
    monkeypatch.setattr(build_store, "finish_job_if_building", lambda **_kwargs: called.__setitem__("n", 1))
    chunks = asyncio.run(
        _collect(
            build_service.iter_build_log(
                builder,
                tenant_id="acme",
                context_id="ctx-1",
                task_id=TASK_ID,
                job_status="building",
            )
        )
    )
    assert chunks == []
    assert called["n"] == 0


def test_tar_over_limit_is_rejected(monkeypatch: pytest.MonkeyPatch):
    builder = _Builder()
    _enable(monkeypatch, builder)
    settings = _settings(bff_image_build_max_total_bytes=4)
    monkeypatch.setattr(build_store, "get_context", lambda *_args: _context())
    monkeypatch.setattr(
        build_service,
        "assemble_and_store_tar",
        lambda *_args, **_kwargs: (b"xxxxx", "digest"),
    )
    with pytest.raises(BuildContextError) as exc:
        asyncio.run(
            build_service.submit_build(
                settings, "acme", "ctx-1", {"imageName": "app:1", "basicStruct": "1"}, "alice"
            )
        )
    assert exc.value.message == "tar 包超过大小限制（4 字节）"
    assert builder.submitted is None


async def _collect(agen) -> list[bytes]:
    return [chunk async for chunk in agen]
