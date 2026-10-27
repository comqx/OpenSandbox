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
from app.prometheus_ssrf import validate_prometheus_base_url
from app.recommendation_defaults import DEFAULT_CPU_PEAK_PROMQL, DEFAULT_CPU_PROMQL, DEFAULT_MEMORY_PROMQL

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

RESOURCE_RECOMMENDATION_KEYS = (
    "enabled",
    "prometheusUrl",
    "memoryPromql",
    "cpuPromql",
    "cpuPeakPromql",
    "percentile",
    "cpuPercentile",
    "memoryPercentile",
    "cpuLimitRatio",
    "cpuLimitFloor",
    "memoryLimitRatio",
    "memoryLimitFloor",
    "schemaVersion",
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
                    _OVERRIDES = data
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read platform settings file %s: %s", path, exc)
        logger.info("Platform settings persistence: file %s", path)


def persistence_available() -> bool:
    return _PERSIST_MODE in ("file", "db")


def _grafana_defaults(settings: Settings) -> dict[str, Any]:
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


def _resource_recommendation_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "prometheusUrl": "",
        "memoryPromql": DEFAULT_MEMORY_PROMQL,
        "cpuPromql": DEFAULT_CPU_PROMQL,
        "cpuPeakPromql": DEFAULT_CPU_PEAK_PROMQL,
        "percentile": 95,
        "cpuPercentile": 95,
        "memoryPercentile": 95,
        "cpuLimitRatio": 1.2,
        "cpuLimitFloor": "100m",
        "memoryLimitRatio": 1.15,
        "memoryLimitFloor": "200Mi",
        "schemaVersion": 2,
    }


def merge_resource_recommendation(overrides: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
    """Merge saved recommendation settings onto defaults.

    Documents saved before schemaVersion 2 stored limit ratios that multiplied a
    pooled p95. Those ratios are not peak headroom, so they are replaced by the
    new defaults until an admin saves again. The returned flag is true when that
    replacement happened.
    """
    from app.recommendation_defaults import canonicalize_recommendation_promql

    merged = _resource_recommendation_defaults()
    if not overrides:
        return merged, False

    for key in RESOURCE_RECOMMENDATION_KEYS:
        if key == "schemaVersion" or key not in overrides:
            continue
        value = overrides[key]
        if key in ("memoryPromql", "cpuPromql") and isinstance(value, str):
            value = canonicalize_recommendation_promql(key, value)
        merged[key] = value

    _fill_split_percentiles(merged, overrides)

    if overrides.get("schemaVersion") == 2:
        merged["schemaVersion"] = 2
        return merged, False

    defaults = _resource_recommendation_defaults()
    merged["cpuLimitRatio"] = defaults["cpuLimitRatio"]
    merged["memoryLimitRatio"] = defaults["memoryLimitRatio"]
    merged["schemaVersion"] = 1
    return merged, True


def _fill_split_percentiles(merged: dict[str, Any], overrides: dict[str, Any] | None) -> None:
    """Old settings stored one percentile. Use it for both resources until each is saved."""
    legacy = merged.get("percentile", 95)
    source = overrides or {}
    if "cpuPercentile" not in source:
        merged["cpuPercentile"] = legacy
    if "memoryPercentile" not in source:
        merged["memoryPercentile"] = legacy


def _parse_percentile(name: str, value: Any) -> float:
    parsed = float(value)
    if parsed <= 0 or parsed > 100:
        raise ValueError(f"{name} must be between 0 and 100")
    return parsed


def apply_recommendation_save(current: dict[str, Any] | None, rec_patch: dict[str, Any]) -> dict[str, Any]:
    """Persist a recommendation settings update.

    The first save after the per-sandbox algorithm ships as schemaVersion 2 and
    always stores the new headroom defaults. Ratios in that upgrade request are
    the old pooled-p95 multipliers, so they are discarded. Later saves keep the
    headroom the admin submitted.
    """
    from app.recommendation_defaults import canonicalize_recommendation_promql

    base = dict(current or {})
    merged = {**base, **rec_patch, "schemaVersion": 2}
    defaults = _resource_recommendation_defaults()
    if base.get("schemaVersion") != 2:
        merged["cpuLimitRatio"] = defaults["cpuLimitRatio"]
        merged["memoryLimitRatio"] = defaults["memoryLimitRatio"]
        if "cpuPeakPromql" not in rec_patch:
            merged["cpuPeakPromql"] = defaults["cpuPeakPromql"]
    for key in ("memoryPromql", "cpuPromql"):
        if isinstance(merged.get(key), str):
            merged[key] = canonicalize_recommendation_promql(key, merged[key])
    if not merged.get("cpuPeakPromql"):
        merged["cpuPeakPromql"] = defaults["cpuPeakPromql"]
    return merged


def _merged_resource_recommendation() -> dict[str, Any]:
    nested = _OVERRIDES.get("resourceRecommendation")
    merged, _reset = merge_resource_recommendation(nested if isinstance(nested, dict) else None)
    return merged


def get_resource_recommendation_runtime(settings: Settings) -> tuple[dict[str, Any], list[str]]:
    """Effective recommendation settings plus compute warnings caused by migration."""
    _ = settings
    nested = _OVERRIDES.get("resourceRecommendation")
    merged, headroom_reset = merge_resource_recommendation(nested if isinstance(nested, dict) else None)
    warnings = ["headroom_defaults_applied"] if headroom_reset else []
    return merged, warnings


def get_resource_recommendation_settings(settings: Settings) -> dict[str, Any]:
    """Effective resource recommendation settings (defaults + persisted overrides)."""
    _ = settings
    return _merged_resource_recommendation()


def get_platform_settings(settings: Settings) -> dict[str, Any]:
    merged = _grafana_defaults(settings)
    merged.update({k: v for k, v in _OVERRIDES.items() if k in GRAFANA_SETTING_KEYS})
    return {
        **merged,
        "resourceRecommendation": _merged_resource_recommendation(),
        "persisted": persistence_available(),
        "source": _PERSIST_MODE,
    }


def _validate_grafana_patch(body: dict[str, Any]) -> dict[str, Any]:
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


def _normalize_resource_recommendation_promql(val: str) -> str:
    """Accept common single-brace typos; BFF substitution always uses {{name}}."""
    out = val
    for name in ("namespace", "pod_regex", "pod"):
        single = "{" + name + "}"
        double = "{{" + name + "}}"
        if single in out and double not in out:
            out = out.replace(single, double)
    return out


def _validate_resource_recommendation_patch(body: dict[str, Any], settings: Settings) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("resourceRecommendation must be an object")
    patch: dict[str, Any] = {}
    if "enabled" in body:
        patch["enabled"] = bool(body["enabled"])
    if "prometheusUrl" in body:
        raw = str(body["prometheusUrl"]).strip()
        if raw:
            patch["prometheusUrl"] = _validate_prometheus_url(raw, settings)
        else:
            patch["prometheusUrl"] = ""
    for key in ("memoryPromql", "cpuPromql", "cpuPeakPromql"):
        if key in body:
            val = _normalize_resource_recommendation_promql(str(body[key]).strip())
            if not val:
                raise ValueError(f"{key} must be non-empty when set")
            has_pod = "{{pod}}" in val or "{{pod_regex}}" in val
            if "{{namespace}}" not in val or not has_pod:
                raise ValueError(
                    f'{key} must contain "{{namespace}}" and "{{pod}}" or "{{pod_regex}}" (two braces each)',
                )
            patch[key] = val
    if "cpuPercentile" in body:
        patch["cpuPercentile"] = _parse_percentile("cpuPercentile", body["cpuPercentile"])
    if "memoryPercentile" in body:
        patch["memoryPercentile"] = _parse_percentile("memoryPercentile", body["memoryPercentile"])
    if "percentile" in body:
        legacy = _parse_percentile("percentile", body["percentile"])
        patch["percentile"] = legacy
        patch.setdefault("cpuPercentile", legacy)
        patch.setdefault("memoryPercentile", legacy)
    if "cpuLimitRatio" in body:
        ratio = float(body["cpuLimitRatio"])
        if ratio <= 0:
            raise ValueError("cpuLimitRatio must be positive")
        patch["cpuLimitRatio"] = ratio
    if "memoryLimitRatio" in body:
        ratio = float(body["memoryLimitRatio"])
        if ratio <= 0:
            raise ValueError("memoryLimitRatio must be positive")
        patch["memoryLimitRatio"] = ratio
    if "cpuLimitFloor" in body or "memoryLimitFloor" in body:
        from app.resource_recommendation import parse_cpu_cores, parse_memory_bytes

    if "cpuLimitFloor" in body:
        floor = str(body["cpuLimitFloor"]).strip()
        parse_cpu_cores(floor)
        patch["cpuLimitFloor"] = floor
    if "memoryLimitFloor" in body:
        floor = str(body["memoryLimitFloor"]).strip()
        parse_memory_bytes(floor)
        patch["memoryLimitFloor"] = floor
    return patch


def _validate_prometheus_url(raw: str, settings: Settings) -> str:
    return validate_prometheus_base_url(raw, allow_internal=settings.bff_prometheus_allow_internal)


def save_platform_settings(settings: Settings, body: dict[str, Any]) -> dict[str, Any]:
    global _OVERRIDES
    if not persistence_available():
        raise RuntimeError(
            "Platform settings are read-only: enable BFF history DB or set BFF_PLATFORM_SETTINGS_PATH",
        )
    grafana_patch = _validate_grafana_patch(body)
    _OVERRIDES = {**_OVERRIDES, **grafana_patch}

    if "resourceRecommendation" in body:
        rec_patch = _validate_resource_recommendation_patch(body["resourceRecommendation"], settings)
        current = _OVERRIDES.get("resourceRecommendation")
        if not isinstance(current, dict):
            current = {}
        _OVERRIDES["resourceRecommendation"] = apply_recommendation_save(current, rec_patch)

    if _PERSIST_MODE == "db":
        from app.history.store import save_platform_settings_to_db

        save_platform_settings_to_db(_OVERRIDES)
    elif _PERSIST_MODE == "file":
        path = Path(settings.bff_platform_settings_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(_OVERRIDES, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return get_platform_settings(settings)
