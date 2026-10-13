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
from datetime import datetime
from typing import Any

from app.history import store as history_store


def _iso_timestamp(value: Any) -> str | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=datetime.now().astimezone().tzinfo).isoformat()
        return value.isoformat()
    return None


def _row_api(row: dict[str, Any]) -> dict[str, Any]:
    manifest = row.get("manifest")
    if isinstance(manifest, str):
        try:
            manifest = json.loads(manifest)
        except json.JSONDecodeError:
            manifest = {}
    if not isinstance(manifest, dict):
        manifest = {}
    return {
        "id": row["id"],
        "tenantId": row["tenant_id"],
        "displayName": row["display_name"],
        "buildVersion": str(manifest.get("buildVersion") or ""),
        "remark": str(manifest.get("remark") or ""),
        "status": row["status"],
        "manifest": manifest,
        "dockerfilePath": row.get("dockerfile_path") or "Dockerfile",
        "tarOssKey": row.get("tar_oss_key"),
        "tarSha256": row.get("tar_sha256"),
        "tarSizeBytes": row.get("tar_size_bytes"),
        "createdBy": row.get("created_by") or "",
        "updatedBy": row.get("updated_by") or "",
        "createdAt": _iso_timestamp(row.get("created_at")),
        "updatedAt": _iso_timestamp(row.get("updated_at")),
    }


def list_contexts(tenant_id: str) -> list[dict[str, Any]]:
    pool = history_store._pool
    if pool is None:
        return []
    with pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM console_sandbox_build_context
            WHERE tenant_id = %s
            ORDER BY updated_at DESC, display_name ASC
            """,
            (tenant_id,),
        ).fetchall()
    return [_row_api(row) for row in rows]


def get_context(tenant_id: str, context_id: str) -> dict[str, Any] | None:
    pool = history_store._pool
    if pool is None:
        return None
    with pool.connection() as conn:
        row = conn.execute(
            """
            SELECT * FROM console_sandbox_build_context
            WHERE tenant_id = %s AND id = %s
            """,
            (tenant_id, context_id),
        ).fetchone()
    if row is None:
        return None
    return _row_api(row)


def insert_context(row: dict[str, Any]) -> dict[str, Any]:
    pool = history_store._pool
    if pool is None:
        raise RuntimeError("History pool not initialized")
    with pool.connection() as conn:
        saved = conn.execute(
            """
            INSERT INTO console_sandbox_build_context (
                id, tenant_id, display_name, status, manifest, dockerfile_path,
                created_by, updated_by
            )
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s)
            RETURNING *
            """,
            (
                row["id"],
                row["tenantId"],
                row["displayName"],
                row.get("status", "draft"),
                json.dumps(row.get("manifest") or {}),
                row.get("dockerfilePath", "Dockerfile"),
                row.get("createdBy", ""),
                row.get("updatedBy", ""),
            ),
        ).fetchone()
    return _row_api(saved)


def update_context(
    tenant_id: str,
    context_id: str,
    *,
    display_name: str | None = None,
    dockerfile_path: str | None = None,
    manifest: dict[str, Any] | None = None,
    status: str | None = None,
    tar_oss_key: str | None = None,
    tar_sha256: str | None = None,
    tar_size_bytes: int | None = None,
    updated_by: str = "",
    clear_tar: bool = False,
) -> dict[str, Any] | None:
    pool = history_store._pool
    if pool is None:
        raise RuntimeError("History pool not initialized")

    fields: list[str] = ["updated_by = %s", "updated_at = NOW()"]
    values: list[Any] = [updated_by]

    if display_name is not None:
        fields.append("display_name = %s")
        values.append(display_name)
    if dockerfile_path is not None:
        fields.append("dockerfile_path = %s")
        values.append(dockerfile_path)
    if manifest is not None:
        fields.append("manifest = %s::jsonb")
        values.append(json.dumps(manifest))
    if status is not None:
        fields.append("status = %s")
        values.append(status)
    if clear_tar:
        fields.extend(["tar_oss_key = NULL", "tar_sha256 = NULL", "tar_size_bytes = NULL"])
    elif tar_oss_key is not None:
        fields.append("tar_oss_key = %s")
        values.append(tar_oss_key)
        fields.append("tar_sha256 = %s")
        values.append(tar_sha256)
        fields.append("tar_size_bytes = %s")
        values.append(tar_size_bytes)

    values.extend([tenant_id, context_id])
    sql = f"""
        UPDATE console_sandbox_build_context
        SET {", ".join(fields)}
        WHERE tenant_id = %s AND id = %s
        RETURNING *
    """
    with pool.connection() as conn:
        saved = conn.execute(sql, tuple(values)).fetchone()
    if saved is None:
        return None
    return _row_api(saved)


def delete_context(tenant_id: str, context_id: str) -> bool:
    pool = history_store._pool
    if pool is None:
        raise RuntimeError("History pool not initialized")
    with pool.connection() as conn:
        deleted = conn.execute(
            """
            DELETE FROM console_sandbox_build_context
            WHERE tenant_id = %s AND id = %s
            RETURNING id
            """,
            (tenant_id, context_id),
        ).fetchone()
    return deleted is not None
