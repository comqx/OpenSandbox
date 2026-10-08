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

import asyncio
from typing import Any

import httpx
from fastapi import HTTPException, Request, status

from app.config import Settings
from app.grafana_monitor import build_sandbox_monitor
from app.history import store as history_store
from app.lifecycle import LifecycleClient
from app.routes.proxy_utils import passthrough_json
from app.routes.session_keys import api_key_for_tenant_name, tenant_namespace_for_name


async def _fetch_sandbox(settings: Settings, tenant_name: str, sandbox_id: str) -> dict[str, Any] | None:
    client = LifecycleClient(settings)
    api_key = api_key_for_tenant_name(tenant_name)
    resp = await client.request(api_key, "GET", f"/sandboxes/{sandbox_id}")
    if resp.status_code == 404:
        return None
    if resp.status_code >= 400:
        body = await passthrough_json(resp)
        raise HTTPException(
            status_code=resp.status_code,
            detail=body if isinstance(body, dict) else {"code": "UPSTREAM", "message": str(body)},
        )
    data = await passthrough_json(resp)
    return data if isinstance(data, dict) else None


async def sandbox_monitor_response(
    settings: Settings,
    request: Request,
    *,
    sandbox_id: str,
    tenant_name: str,
) -> dict[str, Any]:
    k8s_namespace = tenant_namespace_for_name(tenant_name)
    sandbox = await _fetch_sandbox(settings, tenant_name, sandbox_id)
    history = await asyncio.to_thread(
        history_store.get_history_record,
        settings,
        sandbox_id=sandbox_id,
        tenant_name=tenant_name,
    )
    if sandbox is None and history is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Sandbox not found for this tenant"},
        )

    base = str(request.base_url).rstrip("/")
    return await build_sandbox_monitor(
        settings,
        sandbox_id=sandbox_id,
        tenant_name=tenant_name,
        k8s_namespace=k8s_namespace,
        sandbox=sandbox,
        history=history,
        request_base_url=base,
    )
