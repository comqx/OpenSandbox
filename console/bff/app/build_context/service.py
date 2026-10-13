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

import base64
import io
import tarfile
import uuid
from typing import Any

from app.build_context import store as build_store
from app.build_context.oss_client import BuildContextOss, file_object_key, oss_settings, sha256_hex, tar_object_key
from app.build_context.paths import normalize_relative_path
from app.config import Settings
from app.history.store import history_pool_available


class BuildContextError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def feature_meta(settings: Settings) -> dict[str, Any]:
    enabled = is_enabled(settings)
    return {
        "persisted": enabled,
        "source": "db+oss" if enabled else "disabled",
    }


def is_enabled(settings: Settings) -> bool:
    return bool(
        settings.bff_image_build_enabled
        and history_pool_available()
        and oss_settings(settings) is not None
    )


def _require_enabled(settings: Settings) -> None:
    if not is_enabled(settings):
        raise BuildContextError(
            "IMAGE_BUILD_NOT_CONFIGURED",
            "Enable BFF_IMAGE_BUILD_ENABLED with history DB and OSS credentials",
            503,
        )


def _empty_manifest(dockerfile_path: str) -> dict[str, Any]:
    return {"version": 1, "dockerfile": dockerfile_path, "files": {}}


def _normalize_build_version(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        raise BuildContextError("VERSION_REQUIRED", "buildVersion is required")
    if len(text) > 64:
        raise BuildContextError("VERSION_TOO_LONG", "buildVersion must be at most 64 characters")
    return text


def _normalize_remark(raw: Any) -> str:
    text = str(raw or "").strip()
    if len(text) > 512:
        raise BuildContextError("REMARK_TOO_LONG", "remark must be at most 512 characters")
    return text


def _decode_file_body(body: dict[str, Any]) -> tuple[str, bytes]:
    encoding = str(body.get("encoding") or "utf-8").strip()
    if encoding not in ("utf-8", "base64"):
        raise BuildContextError("INVALID_ENCODING", "encoding must be utf-8 or base64")
    content = body.get("content")
    if not isinstance(content, str):
        raise BuildContextError("INVALID_CONTENT", "content must be a string")
    if encoding == "utf-8":
        return encoding, content.encode("utf-8")
    try:
        return encoding, base64.b64decode(content, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise BuildContextError("INVALID_BASE64", "content is not valid base64") from exc


def _check_limits(settings: Settings, manifest_files: dict[str, Any], new_size: int) -> None:
    if len(manifest_files) > settings.bff_image_build_max_files:
        raise BuildContextError("TOO_MANY_FILES", "Build context file count exceeded")
    if new_size > settings.bff_image_build_max_file_bytes:
        raise BuildContextError("FILE_TOO_LARGE", "File exceeds max size")
    total = sum(int(meta.get("size") or 0) for meta in manifest_files.values())
    if total > settings.bff_image_build_max_total_bytes:
        raise BuildContextError("CONTEXT_TOO_LARGE", "Build context total size exceeded")


def list_contexts(settings: Settings, tenant_id: str) -> dict[str, Any]:
    _require_enabled(settings)
    return {**feature_meta(settings), "items": build_store.list_contexts(tenant_id)}


def create_context(settings: Settings, tenant_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    _require_enabled(settings)
    display_name = str(body.get("displayName") or "").strip()
    if not display_name:
        raise BuildContextError("DISPLAY_NAME_REQUIRED", "displayName is required")
    dockerfile_raw = str(body.get("dockerfilePath") or "Dockerfile")
    dockerfile_path = normalize_relative_path(dockerfile_raw) or "Dockerfile"
    context_id = str(uuid.uuid4())
    manifest = _empty_manifest(dockerfile_path)
    if "buildVersion" in body:
        manifest["buildVersion"] = _normalize_build_version(body.get("buildVersion"))
    if "remark" in body:
        manifest["remark"] = _normalize_remark(body.get("remark"))
    return build_store.insert_context(
        {
            "id": context_id,
            "tenantId": tenant_id,
            "displayName": display_name[:120],
            "status": "draft",
            "manifest": manifest,
            "dockerfilePath": dockerfile_path,
            "createdBy": actor,
            "updatedBy": actor,
        }
    )


def get_context(settings: Settings, tenant_id: str, context_id: str) -> dict[str, Any]:
    _require_enabled(settings)
    row = build_store.get_context(tenant_id, context_id)
    if row is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    return row


def patch_context(
    settings: Settings,
    tenant_id: str,
    context_id: str,
    body: dict[str, Any],
    actor: str,
) -> dict[str, Any]:
    _require_enabled(settings)
    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)

    display_name = body.get("displayName")
    dockerfile_path = body.get("dockerfilePath")
    normalized_dockerfile = None
    if dockerfile_path is not None:
        normalized_dockerfile = normalize_relative_path(str(dockerfile_path))
        if normalized_dockerfile is None:
            raise BuildContextError("INVALID_DOCKERFILE_PATH", "dockerfilePath is invalid")

    manifest = dict(existing["manifest"])
    manifest_dirty = False
    if normalized_dockerfile:
        manifest["dockerfile"] = normalized_dockerfile
        manifest_dirty = True
    if "buildVersion" in body:
        manifest["buildVersion"] = _normalize_build_version(body.get("buildVersion"))
        manifest_dirty = True
    if "remark" in body:
        manifest["remark"] = _normalize_remark(body.get("remark"))
        manifest_dirty = True

    updated = build_store.update_context(
        tenant_id,
        context_id,
        display_name=str(display_name).strip()[:120] if display_name is not None else None,
        dockerfile_path=normalized_dockerfile,
        manifest=manifest if manifest_dirty else None,
        updated_by=actor,
        clear_tar=bool(normalized_dockerfile),
    )
    if updated is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    return updated


def put_file(
    settings: Settings,
    tenant_id: str,
    context_id: str,
    raw_path: str,
    body: dict[str, Any],
    actor: str,
) -> dict[str, Any]:
    _require_enabled(settings)
    relative_path = normalize_relative_path(raw_path)
    if relative_path is None:
        raise BuildContextError("INVALID_PATH", "File path is invalid")

    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)

    encoding, data = _decode_file_body(body)
    manifest = dict(existing["manifest"])
    files_meta: dict[str, Any] = dict(manifest.get("files") or {})
    files_meta[relative_path] = {"encoding": encoding, "size": len(data)}
    _check_limits(settings, files_meta, len(data))

    digest = sha256_hex(data)
    oss = BuildContextOss(settings)
    key = file_object_key(oss.prefix, tenant_id, context_id, relative_path, digest)
    content_type = "text/plain; charset=utf-8" if encoding == "utf-8" else "application/octet-stream"
    oss.put_bytes(key, data, content_type=content_type, sha256_hex=digest, tenant_id=tenant_id)

    files_meta[relative_path] = {
        "encoding": encoding,
        "size": len(data),
        "sha256": digest,
        "ossKey": key,
    }
    manifest["files"] = files_meta
    updated = build_store.update_context(
        tenant_id,
        context_id,
        manifest=manifest,
        updated_by=actor,
        clear_tar=True,
    )
    if updated is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    return {"path": relative_path, "sha256": digest, "size": len(data)}


def get_file_content(
    settings: Settings,
    tenant_id: str,
    context_id: str,
    raw_path: str,
) -> dict[str, Any]:
    _require_enabled(settings)
    relative_path = normalize_relative_path(raw_path)
    if relative_path is None:
        raise BuildContextError("INVALID_PATH", "File path is invalid")

    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)

    files_meta: dict[str, Any] = existing["manifest"].get("files") or {}
    meta = files_meta.get(relative_path)
    if not meta or not meta.get("ossKey"):
        raise BuildContextError("NOT_FOUND", "File not found in context", 404)

    oss = BuildContextOss(settings)
    data = oss.get_bytes(str(meta["ossKey"]))
    encoding = str(meta.get("encoding") or "utf-8")
    if encoding == "utf-8":
        return {"path": relative_path, "encoding": encoding, "content": data.decode("utf-8")}
    return {
        "path": relative_path,
        "encoding": encoding,
        "content": base64.b64encode(data).decode("ascii"),
    }


def delete_file(
    settings: Settings,
    tenant_id: str,
    context_id: str,
    raw_path: str,
    actor: str,
) -> None:
    _require_enabled(settings)
    relative_path = normalize_relative_path(raw_path)
    if relative_path is None:
        raise BuildContextError("INVALID_PATH", "File path is invalid")

    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)

    manifest = dict(existing["manifest"])
    files_meta: dict[str, Any] = dict(manifest.get("files") or {})
    meta = files_meta.pop(relative_path, None)
    if meta and meta.get("ossKey"):
        oss = BuildContextOss(settings)
        oss.delete_object(str(meta["ossKey"]))
    manifest["files"] = files_meta
    build_store.update_context(
        tenant_id,
        context_id,
        manifest=manifest,
        updated_by=actor,
        clear_tar=True,
    )


def build_and_store_tar(
    settings: Settings,
    tenant_id: str,
    context_id: str,
    actor: str,
) -> dict[str, Any]:
    _require_enabled(settings)
    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)

    manifest = existing["manifest"]
    files_meta: dict[str, Any] = manifest.get("files") or {}
    dockerfile_path = str(manifest.get("dockerfile") or existing["dockerfilePath"])
    if dockerfile_path not in files_meta:
        raise BuildContextError("DOCKERFILE_MISSING", f"Missing file: {dockerfile_path}")

    oss = BuildContextOss(settings)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for path in sorted(files_meta.keys()):
            meta = files_meta[path]
            if not meta.get("ossKey"):
                raise BuildContextError("FILE_NOT_UPLOADED", f"File not uploaded: {path}")
            data = oss.get_bytes(str(meta["ossKey"]))
            info = tarfile.TarInfo(name=path)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))

    tar_bytes = buffer.getvalue()
    digest = sha256_hex(tar_bytes)
    key = tar_object_key(oss.prefix, tenant_id, context_id)
    oss.put_bytes(
        key,
        tar_bytes,
        content_type="application/x-tar",
        sha256_hex=digest,
        tenant_id=tenant_id,
    )
    updated = build_store.update_context(
        tenant_id,
        context_id,
        status="ready",
        tar_oss_key=key,
        tar_sha256=digest,
        tar_size_bytes=len(tar_bytes),
        updated_by=actor,
    )
    if updated is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    return {
        "tarSha256": digest,
        "tarSizeBytes": len(tar_bytes),
        "downloadUrl": oss.sign_get_url(key),
    }


def tar_download_url(settings: Settings, tenant_id: str, context_id: str) -> dict[str, Any]:
    _require_enabled(settings)
    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    key = existing.get("tarOssKey")
    if not key:
        raise BuildContextError("TAR_NOT_BUILT", "Run POST .../tar to build context archive first", 404)
    oss = BuildContextOss(settings)
    return {
        "downloadUrl": oss.sign_get_url(str(key)),
        "tarSha256": existing.get("tarSha256"),
        "tarSizeBytes": existing.get("tarSizeBytes"),
    }


def delete_context(settings: Settings, tenant_id: str, context_id: str) -> None:
    _require_enabled(settings)
    existing = build_store.get_context(tenant_id, context_id)
    if existing is None:
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
    oss = BuildContextOss(settings)
    files_meta: dict[str, Any] = existing.get("manifest", {}).get("files") or {}
    for meta in files_meta.values():
        oss_key = meta.get("ossKey") if isinstance(meta, dict) else None
        if oss_key:
            oss.delete_object(str(oss_key))
    tar_key = existing.get("tarOssKey")
    if tar_key:
        oss.delete_object(str(tar_key))
    if not build_store.delete_context(tenant_id, context_id):
        raise BuildContextError("NOT_FOUND", "Build context not found", 404)
