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

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from app.build_context import service as build_service
from app.build_context.builder_client import BuilderClient
from app.build_context.service import BuildContextError
from app.config import get_settings
from app.deps import get_session_payload
from app.image_catalog import actor_label

router = APIRouter(prefix="/images/build-contexts", tags=["images"])


def _error(exc: BuildContextError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": exc.message},
    )


def _tenant_scope(payload: dict[str, Any], tenant: str | None) -> str:
    role = payload.get("role")
    if role == "tenant":
        return str(payload.get("tenant") or "")
    if role == "admin":
        cleaned = (tenant or "").strip()
        if not cleaned:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "TENANT_REQUIRED", "message": "Admin requests require tenant query param"},
            )
        return cleaned
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": "FORBIDDEN", "message": "Session not allowed"},
    )


@router.get("")
async def list_build_contexts(
    request: Request,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    del request
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.list_contexts(settings, tenant_id)
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_build_context(
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.create_context(settings, tenant_id, body, actor_label(payload))
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.get("/{context_id}")
async def get_build_context(
    context_id: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.get_context(settings, tenant_id, context_id)
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.patch("/{context_id}")
async def patch_build_context(
    context_id: str,
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.patch_context(settings, tenant_id, context_id, body, actor_label(payload))
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.put("/{context_id}/files/{path:path}")
async def put_build_context_file(
    context_id: str,
    path: str,
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.put_file(settings, tenant_id, context_id, path, body, actor_label(payload))
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.get("/{context_id}/files/{path:path}")
async def get_build_context_file(
    context_id: str,
    path: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.get_file_content(settings, tenant_id, context_id, path)
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.delete("/{context_id}/files/{path:path}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_build_context_file(
    context_id: str,
    path: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> None:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        build_service.delete_file(settings, tenant_id, context_id, path, actor_label(payload))
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.post("/{context_id}/tar")
async def post_build_context_tar(
    context_id: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.build_and_store_tar(settings, tenant_id, context_id, actor_label(payload))
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.get("/{context_id}/tar")
async def get_build_context_tar(
    context_id: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return build_service.tar_download_url(settings, tenant_id, context_id)
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.post("/{context_id}/builds")
async def post_build(
    context_id: str,
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> dict[str, Any]:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        return await build_service.submit_build(
            settings,
            tenant_id,
            context_id,
            body,
            actor_label(payload),
        )
    except BuildContextError as exc:
        raise _error(exc) from exc


@router.get("/{context_id}/builds/{task_id}/logs")
async def get_build_logs(
    context_id: str,
    task_id: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> StreamingResponse:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        job = build_service.get_build_job(settings, tenant_id, context_id, task_id)
    except BuildContextError as exc:
        raise _error(exc) from exc
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Build job not found"},
        )
    client = BuilderClient(settings.bff_image_builder_base_url)
    return StreamingResponse(
        build_service.iter_build_log(
            client,
            tenant_id=tenant_id,
            context_id=context_id,
            task_id=task_id,
            job_status=str(job.get("status") or ""),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.delete("/{context_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_build_context(
    context_id: str,
    payload: dict = Depends(get_session_payload),
    tenant: str | None = Query(default=None),
) -> None:
    settings = get_settings()
    tenant_id = _tenant_scope(payload, tenant)
    try:
        build_service.delete_context(settings, tenant_id, context_id)
    except BuildContextError as exc:
        raise _error(exc) from exc
