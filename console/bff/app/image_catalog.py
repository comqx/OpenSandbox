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
import logging
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from psycopg.errors import UniqueViolation

from app.config import Settings

logger = logging.getLogger(__name__)

_MAX_NAME = 80
_MAX_URI = 512
_MAX_MAINTAINER = 64
_MAX_TAGS = 40
_MAX_TAG_LEN = 80
_TAG_FIELDS = ("scenarios", "systemPackages", "runtimePackages")

_lock = threading.Lock()
_ITEMS: list[dict[str, Any]] = []
_MODE: Literal["none", "file", "db"] = "none"
_FILE_PATH: Path | None = None


class ImageCatalogError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def actor_label(payload: dict[str, Any]) -> str:
    if payload.get("role") == "admin":
        return "admin"
    tenant = str(payload.get("tenant") or "").strip()
    return tenant or "tenant"


def init_image_catalog(settings: Settings) -> None:
    """Load the shared sandbox image catalog (PostgreSQL, else a JSON file)."""
    global _ITEMS, _MODE, _FILE_PATH
    _ITEMS = []
    _FILE_PATH = None

    from app.history.store import history_pool_available

    if history_pool_available():
        _MODE = "db"
        logger.info("Sandbox image catalog persistence: PostgreSQL")
        return

    path = settings.bff_image_catalog_path.strip()
    if not path:
        _MODE = "none"
        logger.info("Sandbox image catalog persistence: disabled")
        return

    _MODE = "file"
    _FILE_PATH = Path(path)
    if _FILE_PATH.is_file():
        try:
            data = json.loads(_FILE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, list):
                _ITEMS = [item for item in data if isinstance(item, dict) and item.get("id")]
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Failed to read image catalog file %s: %s", path, exc)
    logger.info("Sandbox image catalog persistence: file %s", path)


def catalog_meta() -> dict[str, Any]:
    return {"persisted": _MODE != "none", "source": _MODE}


def list_images() -> dict[str, Any]:
    return {**catalog_meta(), "items": _load_items()}


def create_image(body: dict[str, Any], actor: str) -> dict[str, Any]:
    _require_writable()
    fields = _normalize_body(body, partial=False, actor=actor)
    now = _now()
    row = {
        "id": str(uuid.uuid4()),
        "displayName": fields["displayName"],
        "imageUri": fields["imageUri"],
        "scenarios": fields["scenarios"],
        "systemPackages": fields["systemPackages"],
        "runtimePackages": fields["runtimePackages"],
        "maintainer": fields["maintainer"],
        "createdBy": actor,
        "updatedBy": actor,
        "createdAt": now,
        "updatedAt": now,
    }
    _assert_unique_uri(row["imageUri"])
    return _insert(row)


def update_image(image_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    _require_writable()
    current = _find(image_id)
    if current is None:
        raise ImageCatalogError("NOT_FOUND", "镜像不存在", 404)
    fields = _normalize_body(body, partial=True, actor=actor)
    merged = {**current, **fields, "updatedBy": actor, "updatedAt": _now()}
    _assert_unique_uri(merged["imageUri"], exclude_id=image_id)
    saved = _update(image_id, merged)
    if saved is None:
        raise ImageCatalogError("NOT_FOUND", "镜像不存在", 404)
    return saved


def delete_image(image_id: str) -> None:
    _require_writable()
    if not _delete(image_id):
        raise ImageCatalogError("NOT_FOUND", "镜像不存在", 404)


def _require_writable() -> None:
    if _MODE == "none":
        raise ImageCatalogError(
            "CATALOG_READ_ONLY",
            "镜像目录只读：请启用 BFF 历史库，或设置 BFF_IMAGE_CATALOG_PATH",
            503,
        )


def _normalize_body(body: dict[str, Any], *, partial: bool, actor: str) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ImageCatalogError("INVALID_IMAGE", "请求体必须是 JSON 对象")
    out: dict[str, Any] = {}
    if not partial or "displayName" in body:
        name = str(body.get("displayName") or "").strip()
        if not name:
            raise ImageCatalogError("INVALID_IMAGE", "请填写镜像名称")
        if len(name) > _MAX_NAME:
            raise ImageCatalogError("INVALID_IMAGE", f"镜像名称不能超过 {_MAX_NAME} 个字符")
        out["displayName"] = name
    if not partial or "imageUri" in body:
        uri = str(body.get("imageUri") or "").strip()
        if not uri:
            raise ImageCatalogError("INVALID_IMAGE", "请填写镜像地址")
        if any(ch.isspace() for ch in uri):
            raise ImageCatalogError("INVALID_IMAGE", "镜像地址不能包含空白字符")
        if len(uri) > _MAX_URI:
            raise ImageCatalogError("INVALID_IMAGE", f"镜像地址不能超过 {_MAX_URI} 个字符")
        out["imageUri"] = uri
    for field in _TAG_FIELDS:
        if not partial or field in body:
            out[field] = _tags(body.get(field), field)
    if not partial or "maintainer" in body:
        maintainer = str(body.get("maintainer") or "").strip() or actor
        if len(maintainer) > _MAX_MAINTAINER:
            raise ImageCatalogError("INVALID_IMAGE", f"来源不能超过 {_MAX_MAINTAINER} 个字符")
        out["maintainer"] = maintainer
    if not partial:
        for field in _TAG_FIELDS:
            out.setdefault(field, [])
    return out


def _tags(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw_items = re.split(r"[,，\n]", value)
    elif isinstance(value, list):
        raw_items = value
    else:
        raise ImageCatalogError("INVALID_IMAGE", f"{field} 必须是字符串列表")
    out: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = str(item).strip()
        if not text or text in seen:
            continue
        if len(text) > _MAX_TAG_LEN:
            raise ImageCatalogError("INVALID_IMAGE", f"{field} 单项不能超过 {_MAX_TAG_LEN} 个字符")
        seen.add(text)
        out.append(text)
    if len(out) > _MAX_TAGS:
        raise ImageCatalogError("INVALID_IMAGE", f"{field} 最多 {_MAX_TAGS} 项")
    return out


def _assert_unique_uri(image_uri: str, exclude_id: str | None = None) -> None:
    for item in _load_items():
        if item["imageUri"] == image_uri and item["id"] != exclude_id:
            raise ImageCatalogError("DUPLICATE_IMAGE", "该镜像地址已在目录中", 409)


def _load_items() -> list[dict[str, Any]]:
    if _MODE == "db":
        from app.history.store import list_sandbox_images

        return list_sandbox_images()
    if _MODE != "file":
        return []
    with _lock:
        items = [dict(item) for item in _ITEMS]
    items.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    return items


def _find(image_id: str) -> dict[str, Any] | None:
    for item in _load_items():
        if item["id"] == image_id:
            return item
    return None


def _insert(row: dict[str, Any]) -> dict[str, Any]:
    if _MODE == "db":
        from app.history.store import insert_sandbox_image

        try:
            return insert_sandbox_image(row)
        except UniqueViolation as exc:
            raise ImageCatalogError("DUPLICATE_IMAGE", "该镜像地址已在目录中", 409) from exc
    with _lock:
        _ITEMS.append(row)
        _persist_file()
    return dict(row)


def _update(image_id: str, row: dict[str, Any]) -> dict[str, Any] | None:
    if _MODE == "db":
        from app.history.store import update_sandbox_image

        try:
            return update_sandbox_image(image_id, row)
        except UniqueViolation as exc:
            raise ImageCatalogError("DUPLICATE_IMAGE", "该镜像地址已在目录中", 409) from exc
    with _lock:
        for index, item in enumerate(_ITEMS):
            if item["id"] == image_id:
                _ITEMS[index] = row
                _persist_file()
                return dict(row)
    return None


def _delete(image_id: str) -> bool:
    if _MODE == "db":
        from app.history.store import delete_sandbox_image

        return delete_sandbox_image(image_id)
    with _lock:
        before = len(_ITEMS)
        _ITEMS[:] = [item for item in _ITEMS if item["id"] != image_id]
        if len(_ITEMS) == before:
            return False
        _persist_file()
        return True


def _persist_file() -> None:
    if _FILE_PATH is None:
        return
    _FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(_ITEMS, ensure_ascii=False, indent=2) + "\n"
    tmp = _FILE_PATH.with_suffix(_FILE_PATH.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(_FILE_PATH)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
