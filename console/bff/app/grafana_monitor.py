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

from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

from app.config import Settings
from app.k8s_resources import list_workloads, primary_pod_name_for_sandbox
from app.platform_settings import get_platform_settings

_TERMINAL = frozenset({"Terminated", "Failed", "Stopping"})


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _epoch_ms(dt: datetime) -> str:
    """Grafana dashboard URL from/to expect Unix epoch milliseconds (not arbitrary ISO strings)."""
    ms = int(dt.astimezone(timezone.utc).timestamp() * 1000)
    return str(ms)


def resolve_time_range(
    *,
    sandbox: dict[str, Any] | None,
    history: dict[str, Any] | None,
) -> tuple[datetime, datetime, list[str]]:
    warnings: list[str] = []
    now = datetime.now(timezone.utc)

    created = None
    if sandbox:
        created = _parse_ts(sandbox.get("createdAt"))
    if created is None and history:
        created = _parse_ts(history.get("createdAt")) or _parse_ts(history.get("firstRecordedAt"))

    if created is None:
        created = now
        warnings.append("缺少创建时间，使用当前时间作为 from")

    state = (sandbox or {}).get("status", {}).get("state") or (history or {}).get("state")
    ended = None
    if history:
        ended = _parse_ts(history.get("endedAt")) or _parse_ts(history.get("deletedAt"))
    if state in _TERMINAL and sandbox:
        ended = ended or _parse_ts(sandbox.get("status", {}).get("lastTransitionAt"))

    to_dt = now if state not in _TERMINAL and ended is None else (ended or now)
    if to_dt < created:
        to_dt = created

    return created, to_dt, warnings


def build_grafana_dashboard_path(
    cfg: dict[str, Any],
    *,
    namespace: str,
    pod_names: list[str],
    time_from: datetime,
    time_to: datetime,
) -> str:
    slug = cfg["dashboardSlug"]
    uid = cfg["dashboardUid"]
    params: list[tuple[str, str]] = [
        ("from", _epoch_ms(time_from)),
        ("to", _epoch_ms(time_to)),
        ("timezone", "Asia/Shanghai"),
        (cfg["varNamespace"], namespace),
        ("refresh", cfg["refresh"]),
    ]
    pod_var = cfg["varPod"]
    if pod_names:
        for name in pod_names:
            params.append((pod_var, name))
    else:
        params.append((pod_var, "$__all"))

    params.append((cfg["varNode"], "$__all"))
    # Kiosk: hide Grafana nav / user chrome; keep dashboard variables + time picker (Grafana 10.3+).
    params.extend(
        [
            ("kiosk", "1"),
            ("_dash.hideLinks", "true"),
            ("hideLogo", "1"),
        ]
    )
    if cfg.get("embedExpandRows", True):
        params.append(("expandRows", "true"))
    return f"/d/{slug}/{uid}?{urlencode(params)}"


def build_embed_urls(
    cfg: dict[str, Any],
    dashboard_path: str,
    *,
    request_base: str,
) -> tuple[str, str | None]:
    """Returns (iframeUrl, externalUrl). externalUrl is always the direct Grafana link."""
    base = cfg["baseUrl"].rstrip("/")
    external = f"{base}{dashboard_path}"
    if cfg.get("embedMode") == "proxy":
        proxy_base = request_base.rstrip("/")
        iframe = f"{proxy_base}/api/grafana{dashboard_path}"
        return iframe, external
    return external, external


async def build_sandbox_monitor(
    settings: Settings,
    *,
    sandbox_id: str,
    tenant_name: str,
    k8s_namespace: str,
    sandbox: dict[str, Any] | None,
    history: dict[str, Any] | None,
    request_base_url: str,
) -> dict[str, Any]:
    cfg = get_platform_settings(settings)
    warnings: list[str] = []

    if not cfg.get("enabled"):
        return {
            "enabled": False,
            "message": "Grafana 监控未启用，请在系统设置中配置或设置 BFF_GRAFANA_ENABLED",
        }

    if not cfg.get("baseUrl") or not cfg.get("dashboardSlug") or not cfg.get("dashboardUid"):
        return {
            "enabled": False,
            "message": "Grafana Dashboard 配置不完整（baseUrl / dashboardSlug / dashboardUid）",
        }

    time_from, time_to, time_warnings = resolve_time_range(sandbox=sandbox, history=history)
    warnings.extend(time_warnings)

    pods: list[dict[str, Any]] = []
    workloads = await list_workloads(
        settings,
        tenant=tenant_name,
        namespace=k8s_namespace,
        sandbox_id=sandbox_id,
        limit=20,
    )
    if workloads.get("disabled"):
        warnings.append(workloads.get("message") or "K8s Pod 查询未启用")
    else:
        for item in workloads.get("items") or []:
            if item.get("namespace") != k8s_namespace:
                continue
            pods.append(item)

    pod_names = [p["name"] for p in pods if p.get("name")]
    if not pod_names and sandbox_id.strip():
        pod_names = [primary_pod_name_for_sandbox(sandbox_id)]

    dashboard_path = build_grafana_dashboard_path(
        cfg,
        namespace=k8s_namespace,
        pod_names=pod_names,
        time_from=time_from,
        time_to=time_to,
    )
    iframe_url, external_url = build_embed_urls(cfg, dashboard_path, request_base=request_base_url)

    return {
        "enabled": True,
        "embedMode": cfg.get("embedMode"),
        "iframeUrl": iframe_url,
        "externalUrl": external_url,
        "namespace": k8s_namespace,
        "tenant": tenant_name,
        "sandboxId": sandbox_id,
        "pods": pods,
        "timeRange": {"from": _iso_z(time_from), "to": _iso_z(time_to)},
        "warnings": warnings,
    }
