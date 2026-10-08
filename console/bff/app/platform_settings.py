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
from pathlib import Path
from typing import Any, Literal

from app.config import Settings

logger = logging.getLogger(__name__)

_SETTINGS_ROW_ID = "default"
_OVERRIDES: dict[str, Any] = {}
_PERSIST_MODE: Literal["none", "file", "db"] = "none"

GRAFANA_SETTING_KEYS = (
    "enabled",
    "baseUrl",
    "dashboardSlug",
    "dashboardUid",
    "refresh",
    "embedMode",
    "varNamespace",
    "varPod",
    "varNode",
    "varDatasource",
    "datasourceUid",
    "authProxyEnabled",
    "authProxyUserHeader",
    "embedExpandRows",
)


def init_platform_settings(settings: Settings) -> None:
    """Load persisted Grafana/platform overrides (DB or JSON file)."""
    global _OVERRIDES, _PERSIST_MODE
    _OVERRIDES = {}
    _PERSIST_MODE = "none"

    from app.history.store import history_pool_available, load_platform_settings_from_db

    if history_pool_available():
        row = load_platform_settings_from_db()
        if row:
            _OVERRIDES = row
        _PERSIST_MODE = "db"
        logger.info("Platform settings persistence: PostgreSQL")
        return

    path = settings.bff_platform_settings_path.strip()
    if path:
        _PERSIST_MODE = "file"
        file_path = Path(path)
        if file_path.is_file():
            try:
                data = json.loads(file_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _OVERRIDES = {k: data[k] for k in GRAFANA_SETTING_KEYS if k in data}
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read platform settings file %s: %s", path, exc)
        logger.info("Platform settings persistence: file %s", path)


def persistence_available() -> bool:
    return _PERSIST_MODE in ("file", "db")


def _defaults(settings: Settings) -> dict[str, Any]:
    return {
        "enabled": settings.bff_grafana_enabled,
        "baseUrl": settings.bff_grafana_base_url.rstrip("/"),
        "dashboardSlug": settings.bff_grafana_dashboard_slug,
        "dashboardUid": settings.bff_grafana_dashboard_uid,
        "refresh": settings.bff_grafana_refresh,
        "embedMode": settings.bff_grafana_embed_mode,
        "varNamespace": settings.bff_grafana_var_namespace,
        "varPod": settings.bff_grafana_var_pod,
        "varNode": settings.bff_grafana_var_node,
        "varDatasource": settings.bff_grafana_var_datasource,
        "datasourceUid": settings.bff_grafana_datasource_uid,
        "authProxyEnabled": settings.bff_grafana_auth_proxy_enabled,
        "authProxyUserHeader": settings.bff_grafana_auth_proxy_user_header,
        "embedExpandRows": True,
    }


def get_platform_settings(settings: Settings) -> dict[str, Any]:
    merged = _defaults(settings)
    merged.update({k: v for k, v in _OVERRIDES.items() if k in GRAFANA_SETTING_KEYS})
    return {
        **merged,
        "persisted": persistence_available(),
        "source": _PERSIST_MODE,
    }


def _validate_patch(body: dict[str, Any]) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if "enabled" in body:
        patch["enabled"] = bool(body["enabled"])
    if "baseUrl" in body:
        url = str(body["baseUrl"]).strip().rstrip("/")
        if not url:
            raise ValueError("baseUrl must be non-empty when set")
        patch["baseUrl"] = url
    for key in (
        "dashboardSlug",
        "dashboardUid",
        "refresh",
        "varNamespace",
        "varPod",
        "varNode",
        "varDatasource",
    ):
        if key in body:
            val = str(body[key]).strip()
            if key == "varDatasource":
                patch[key] = val or "var-DS_PROM"
                continue
            if not val:
                raise ValueError(f"{key} must be non-empty when set")
            patch[key] = val
    if "datasourceUid" in body:
        patch["datasourceUid"] = str(body["datasourceUid"]).strip()
    if "embedMode" in body:
        mode = str(body["embedMode"]).strip().lower()
        if mode not in ("direct", "proxy"):
            raise ValueError("embedMode must be direct or proxy")
        patch["embedMode"] = mode
    if "authProxyEnabled" in body:
        patch["authProxyEnabled"] = bool(body["authProxyEnabled"])
    if "authProxyUserHeader" in body:
        header = str(body["authProxyUserHeader"]).strip()
        if not header:
            raise ValueError("authProxyUserHeader must be non-empty when set")
        patch["authProxyUserHeader"] = header
    if "embedExpandRows" in body:
        patch["embedExpandRows"] = bool(body["embedExpandRows"])
    return patch


def save_platform_settings(settings: Settings, body: dict[str, Any]) -> dict[str, Any]:
    global _OVERRIDES
    if not persistence_available():
        raise RuntimeError(
            "Platform settings are read-only: enable BFF history DB or set BFF_PLATFORM_SETTINGS_PATH",
        )
    patch = _validate_patch(body)
    _OVERRIDES = {**_OVERRIDES, **patch}

    if _PERSIST_MODE == "db":
        from app.history.store import save_platform_settings_to_db

        save_platform_settings_to_db(_OVERRIDES)
    elif _PERSIST_MODE == "file":
        path = Path(settings.bff_platform_settings_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(_OVERRIDES, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return get_platform_settings(settings)
