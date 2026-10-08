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

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from app.config import Settings, get_settings
from app.deps import get_session_payload, require_admin_session, require_tenant_session
from app.monitor_context import sandbox_monitor_response
from app.platform_settings import get_platform_settings, save_platform_settings

router = APIRouter(tags=["platform"])
admin_router = APIRouter(prefix="/admin/platform", tags=["admin-platform"])


@admin_router.get("/settings")
async def get_settings_admin(payload: dict = Depends(get_session_payload)) -> dict[str, Any]:
    require_admin_session(payload)
    return get_platform_settings(get_settings())


@admin_router.patch("/settings")
async def patch_settings_admin(
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
) -> dict[str, Any]:
    require_admin_session(payload)
    settings = get_settings()
    try:
        return save_platform_settings(settings, body)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "INVALID_SETTINGS", "message": str(exc)},
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "SETTINGS_READ_ONLY", "message": str(exc)},
        ) from exc


@router.get("/sandboxes/{sandbox_id}/monitor")
async def tenant_sandbox_monitor(
    sandbox_id: str,
    request: Request,
    payload: dict = Depends(get_session_payload),
) -> dict[str, Any]:
    require_tenant_session(payload)
    tenant_name = str(payload.get("tenant"))
    return await sandbox_monitor_response(
        get_settings(),
        request,
        sandbox_id=sandbox_id,
        tenant_name=tenant_name,
    )


def _grafana_upstream_base(settings: Settings) -> str:
    cfg = get_platform_settings(settings)
    base = str(cfg.get("baseUrl") or "").rstrip("/")
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "GRAFANA_NOT_CONFIGURED", "message": "Grafana baseUrl is not set"},
        )
    return base


def _auth_proxy_headers(settings: Settings, payload: dict) -> dict[str, str]:
    cfg = get_platform_settings(settings)
    if not cfg.get("authProxyEnabled"):
        return {}
    header = str(cfg.get("authProxyUserHeader") or "X-WEBAUTH-USER")
    role = payload.get("role")
    if role == "admin":
        user = "console-admin"
    elif role == "tenant":
        user = f"tenant-{payload.get('tenant')}"
    else:
        user = "console-user"
    return {header: user}


async def _proxy_grafana(request: Request, path: str, payload: dict) -> Response:
    settings = get_settings()
    cfg = get_platform_settings(settings)
    if cfg.get("embedMode") != "proxy":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PROXY_DISABLED", "message": "Grafana embedMode is not proxy"},
        )
    upstream = _grafana_upstream_base(settings)
    query = request.url.query
    target = f"{upstream}/{path.lstrip('/')}"
    if query:
        target = f"{target}?{query}"

    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "cookie", "content-length")}
    headers.update(_auth_proxy_headers(settings, payload))

    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        upstream_resp = await client.request(
            request.method,
            target,
            headers=headers,
            content=await request.body(),
        )

    excluded = {"transfer-encoding", "connection", "content-encoding"}
    resp_headers = {
        k: v for k, v in upstream_resp.headers.items() if k.lower() not in excluded
    }
    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        media_type=upstream_resp.headers.get("content-type"),
    )


@router.api_route("/grafana/{path:path}", methods=["GET", "HEAD", "POST"])
async def grafana_proxy(
    path: str,
    request: Request,
    payload: dict = Depends(get_session_payload),
) -> Response:
    role = payload.get("role")
    if role not in ("tenant", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Valid session required for Grafana proxy"},
        )
    if not path.startswith("d/"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Only dashboard paths are proxied"},
        )
    return await _proxy_grafana(request, path, payload)
