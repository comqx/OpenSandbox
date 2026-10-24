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
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import Settings
from app.history.resources import (
    explicit_resource_limits,
    limits_to_numbers,
    parse_cpu_cores,
    parse_memory_gi,
    resource_limits_dict,
)
from app.runtime import attach_runtime_summary

logger = logging.getLogger(__name__)

_SCHEMA_LOCK = "opensandbox-sandbox-lifecycle-history"
_HISTORY_TABLE = "sandbox_lifecycle_history"
_pool: ConnectionPool | None = None

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


def init_history_pool(settings: Settings) -> None:
    global _pool
    if not settings.bff_history_enabled:
        return
    if not settings.bff_history_database_url.strip():
        raise RuntimeError("BFF_HISTORY_ENABLED requires BFF_HISTORY_DATABASE_URL")
    if _pool is not None:
        return
    _pool = ConnectionPool(
        settings.bff_history_database_url,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row},
    )
    _ensure_schema(_pool)
    logger.info("Console sandbox history pool initialized")


def close_history_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def _ensure_schema(pool: ConnectionPool) -> None:
    with pool.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (_SCHEMA_LOCK,))
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sandbox_lifecycle_history (
                sandbox_id TEXT PRIMARY KEY,
                tenant_name TEXT NOT NULL,
                namespace TEXT NOT NULL,
                state TEXT,
                image_uri TEXT,
                lifecycle_created_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                ended_at TIMESTAMPTZ,
                wall_clock_seconds INTEGER,
                source TEXT NOT NULL DEFAULT 'console',
                create_request JSONB,
                first_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                deleted_at TIMESTAMPTZ
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sandbox_lifecycle_history_tenant_created
                ON sandbox_lifecycle_history (tenant_name, lifecycle_created_at DESC NULLS LAST)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sandbox_lifecycle_history_state
                ON sandbox_lifecycle_history (state)
            """
        )
        conn.execute(
            "ALTER TABLE sandbox_lifecycle_history ADD COLUMN IF NOT EXISTS cpu_limit TEXT"
        )
        conn.execute(
            "ALTER TABLE sandbox_lifecycle_history ADD COLUMN IF NOT EXISTS memory_limit TEXT"
        )
        conn.execute(
            "ALTER TABLE sandbox_lifecycle_history ADD COLUMN IF NOT EXISTS cpu_cores DOUBLE PRECISION"
        )
        conn.execute(
            "ALTER TABLE sandbox_lifecycle_history ADD COLUMN IF NOT EXISTS memory_gi DOUBLE PRECISION"
        )
        conn.execute(
            "ALTER TABLE sandbox_lifecycle_history ADD COLUMN IF NOT EXISTS metadata JSONB"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS console_platform_settings (
                id TEXT PRIMARY KEY,
                settings JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS console_sandbox_image_catalog (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                image_uri TEXT NOT NULL,
                scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
                system_packages JSONB NOT NULL DEFAULT '[]'::jsonb,
                runtime_packages JSONB NOT NULL DEFAULT '[]'::jsonb,
                maintainer TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_console_sandbox_image_catalog_uri
                ON console_sandbox_image_catalog (image_uri)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sandbox_resource_recommendation_runs (
                id TEXT PRIMARY KEY,
                tenant_name TEXT,
                created_by_role TEXT NOT NULL,
                created_by_actor TEXT NOT NULL DEFAULT '',
                label TEXT,
                sandbox_id_filter TEXT,
                period_from TIMESTAMPTZ NOT NULL,
                period_to TIMESTAMPTZ NOT NULL,
                window_label TEXT,
                result JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sandbox_resource_recommendation_runs_tenant_created
                ON sandbox_resource_recommendation_runs (tenant_name, created_at DESC)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS console_image_preheat (
                id TEXT PRIMARY KEY,
                preheat_id TEXT NOT NULL,
                image_id TEXT NOT NULL,
                image_uri TEXT NOT NULL,
                tenant_name TEXT NOT NULL,
                namespace TEXT NOT NULL,
                node_name TEXT NOT NULL,
                pod_name TEXT NOT NULL,
                state TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at TIMESTAMPTZ
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_console_image_preheat_image
                ON console_image_preheat (image_id, created_at DESC)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS console_sandbox_build_context (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
                dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
                tar_oss_key TEXT,
                tar_sha256 TEXT,
                tar_size_bytes BIGINT,
                created_by TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_console_sandbox_build_context_tenant_updated
                ON console_sandbox_build_context (tenant_id, updated_at DESC)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_console_sandbox_build_context_tenant_status
                ON console_sandbox_build_context (tenant_id, status)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS console_sandbox_build_job (
                task_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                context_id TEXT NOT NULL,
                image_name TEXT NOT NULL,
                basic_struct TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                tar_sha256 TEXT NOT NULL DEFAULT '',
                submitted_by TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at TIMESTAMPTZ
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_console_sandbox_build_job_context_created
                ON console_sandbox_build_job (context_id, created_at DESC)
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_console_sandbox_build_job_active
                ON console_sandbox_build_job (context_id)
                WHERE status = 'building'
            """
        )


def history_pool_available() -> bool:
    return _pool is not None


def load_platform_settings_from_db() -> dict[str, Any]:
    if _pool is None:
        return {}
    with _pool.connection() as conn:
        row = conn.execute(
            "SELECT settings FROM console_platform_settings WHERE id = %s",
            ("default",),
        ).fetchone()
    if not row:
        return {}
    settings = row["settings"]
    if isinstance(settings, dict):
        return settings
    if isinstance(settings, str):
        try:
            parsed = json.loads(settings)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def save_platform_settings_to_db(overrides: dict[str, Any]) -> None:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO console_platform_settings (id, settings, updated_at)
            VALUES ('default', %s::jsonb, NOW())
            ON CONFLICT (id) DO UPDATE
            SET settings = EXCLUDED.settings, updated_at = NOW()
            """,
            (json.dumps(overrides),),
        )


def _json_list(raw: Any) -> list[str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw]


def _iso_timestamp(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if value is None:
        return None
    return str(value)


def _image_catalog_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "displayName": row["display_name"],
        "imageUri": row["image_uri"],
        "scenarios": _json_list(row.get("scenarios")),
        "systemPackages": _json_list(row.get("system_packages")),
        "runtimePackages": _json_list(row.get("runtime_packages")),
        "maintainer": row.get("maintainer") or "",
        "createdBy": row.get("created_by") or "",
        "updatedBy": row.get("updated_by") or "",
        "createdAt": _iso_timestamp(row.get("created_at")),
        "updatedAt": _iso_timestamp(row.get("updated_at")),
    }


def _preheat_api(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "preheatId": row["preheat_id"],
        "imageId": row["image_id"],
        "imageUri": row["image_uri"],
        "tenant": row["tenant_name"],
        "namespace": row["namespace"],
        "nodeName": row["node_name"],
        "podName": row["pod_name"],
        "state": row["state"],
        "message": row.get("message") or "",
        "createdBy": row.get("created_by") or "",
        "createdAt": _iso_timestamp(row.get("created_at")),
        "finishedAt": _iso_timestamp(row.get("finished_at")),
    }


def insert_image_preheats(rows: list[dict[str, Any]]) -> None:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        for row in rows:
            conn.execute(
                """
                INSERT INTO console_image_preheat (
                    id, preheat_id, image_id, image_uri, tenant_name, namespace,
                    node_name, pod_name, state, message, created_by
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    row["id"],
                    row["preheatId"],
                    row["imageId"],
                    row["imageUri"],
                    row["tenant"],
                    row["namespace"],
                    row["nodeName"],
                    row["podName"],
                    row["state"],
                    row.get("message") or "",
                    row.get("createdBy") or "",
                ),
            )


def list_image_preheats(image_id: str, tenant: str | None) -> list[dict[str, Any]]:
    if _pool is None:
        return []
    with _pool.connection() as conn:
        if tenant:
            rows = conn.execute(
                """
                SELECT * FROM console_image_preheat
                WHERE image_id = %s AND tenant_name = %s
                ORDER BY created_at DESC, node_name ASC
                """,
                (image_id, tenant),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM console_image_preheat
                WHERE image_id = %s
                ORDER BY created_at DESC, node_name ASC
                """,
                (image_id,),
            ).fetchall()
    return [_preheat_api(row) for row in rows]


def mark_image_preheat(row_id: str, state: str, message: str) -> bool:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        updated = conn.execute(
            """
            UPDATE console_image_preheat
            SET state = %s,
                message = %s,
                finished_at = CASE WHEN %s = 'pulling' THEN NULL ELSE NOW() END
            WHERE id = %s AND state = 'pulling'
            """,
            (state, message, state, row_id),
        )
        return updated.rowcount == 1


def list_sandbox_images() -> list[dict[str, Any]]:
    if _pool is None:
        return []
    with _pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM console_sandbox_image_catalog
            ORDER BY updated_at DESC, display_name ASC
            """
        ).fetchall()
    return [_image_catalog_api(row) for row in rows]


def insert_sandbox_image(row: dict[str, Any]) -> dict[str, Any]:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        saved = conn.execute(
            """
            INSERT INTO console_sandbox_image_catalog (
                id, display_name, image_uri, scenarios, system_packages, runtime_packages,
                maintainer, created_by, updated_by
            )
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s)
            RETURNING *
            """,
            (
                row["id"],
                row["displayName"],
                row["imageUri"],
                json.dumps(row["scenarios"]),
                json.dumps(row["systemPackages"]),
                json.dumps(row["runtimePackages"]),
                row["maintainer"],
                row["createdBy"],
                row["updatedBy"],
            ),
        ).fetchone()
    return _image_catalog_api(saved)


def update_sandbox_image(image_id: str, row: dict[str, Any]) -> dict[str, Any] | None:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        saved = conn.execute(
            """
            UPDATE console_sandbox_image_catalog
            SET display_name = %s,
                image_uri = %s,
                scenarios = %s::jsonb,
                system_packages = %s::jsonb,
                runtime_packages = %s::jsonb,
                maintainer = %s,
                updated_by = %s,
                updated_at = NOW()
            WHERE id = %s
            RETURNING *
            """,
            (
                row["displayName"],
                row["imageUri"],
                json.dumps(row["scenarios"]),
                json.dumps(row["systemPackages"]),
                json.dumps(row["runtimePackages"]),
                row["maintainer"],
                row["updatedBy"],
                image_id,
            ),
        ).fetchone()
    if saved is None:
        return None
    return _image_catalog_api(saved)


def delete_sandbox_image(image_id: str) -> bool:
    if _pool is None:
        raise RuntimeError("History pool not initialized")
    with _pool.connection() as conn:
        deleted = conn.execute(
            "DELETE FROM console_sandbox_image_catalog WHERE id = %s RETURNING id",
            (image_id,),
        ).fetchone()
    return deleted is not None


def _coerce_metadata(raw: Any) -> dict[str, str]:
    """Normalize sandbox metadata to a string map. Empty or invalid input is {}."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        name = str(key).strip()
        if not name:
            continue
        out[name] = str(value)
    return out


def _metadata_from_row(row: dict[str, Any]) -> dict[str, str]:
    stored = _coerce_metadata(row.get("metadata"))
    if stored:
        return stored
    create_request = row.get("create_request")
    if isinstance(create_request, str):
        try:
            create_request = json.loads(create_request)
        except json.JSONDecodeError:
            create_request = None
    if isinstance(create_request, dict):
        return _coerce_metadata(create_request.get("metadata"))
    return {}


def _label_terms(query: str | None) -> list[str]:
    if not query:
        return []
    return [part for part in query.strip().split() if part]


def _metadata_matches_label(metadata: dict[str, str], query: str | None) -> bool:
    """Substring match on key, value, or key=value. Space-separated terms are AND."""
    terms = _label_terms(query)
    if not terms:
        return True
    pairs = [(key.lower(), value.lower(), f"{key}={value}".lower()) for key, value in metadata.items()]
    for term in terms:
        needle = term.lower()
        if not any(needle in key or needle in value or needle in pair for key, value, pair in pairs):
            return False
    return True


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _sandbox_id_needle(query: str | None) -> str | None:
    if not query:
        return None
    text = query.strip()
    return text or None


def _sandbox_id_matches(sandbox_id: str | None, query: str | None) -> bool:
    """Case-insensitive substring match on sandbox id."""
    needle = _sandbox_id_needle(query)
    if not needle:
        return True
    return needle.lower() in (sandbox_id or "").lower()


def _sandbox_id_where(alias: str, query: str | None) -> tuple[str, list[Any]]:
    needle = _sandbox_id_needle(query)
    if not needle:
        return "", []
    return (
        f" AND {alias}.sandbox_id ILIKE %s ESCAPE '\\'",
        [f"%{_escape_like(needle)}%"],
    )


def _label_where(alias: str, query: str | None) -> tuple[str, list[Any]]:
    """SQL equivalent of _metadata_matches_label, including create_request fallback."""
    terms = _label_terms(query)
    if not terms:
        return "", []
    meta_expr = f"""
        CASE
            WHEN jsonb_typeof({alias}.metadata) = 'object'
                 AND {alias}.metadata <> '{{}}'::jsonb
                THEN {alias}.metadata
            WHEN jsonb_typeof({alias}.create_request -> 'metadata') = 'object'
                THEN {alias}.create_request -> 'metadata'
            ELSE '{{}}'::jsonb
        END
    """
    clauses: list[str] = []
    params: list[Any] = []
    for term in terms:
        pattern = f"%{_escape_like(term)}%"
        clauses.append(
            f"""EXISTS (
                SELECT 1 FROM jsonb_each_text({meta_expr}) AS kv(k, v)
                WHERE kv.k ILIKE %s ESCAPE '\\'
                   OR kv.v ILIKE %s ESCAPE '\\'
                   OR (kv.k || '=' || kv.v) ILIKE %s ESCAPE '\\'
            )"""
        )
        params.extend([pattern, pattern, pattern])
    return " AND " + " AND ".join(clauses), params


def _image_uri(sandbox: dict[str, Any]) -> str | None:
    image = sandbox.get("image")
    if isinstance(image, dict):
        uri = image.get("uri")
        return str(uri) if uri else None
    if isinstance(image, str):
        return image
    return None


def upsert_from_sandbox(
    settings: Settings,
    *,
    tenant_name: str,
    namespace: str,
    sandbox: dict[str, Any],
    source: str = "console",
    create_request: dict[str, Any] | None = None,
) -> None:
    if not settings.bff_history_enabled or _pool is None:
        return
    sandbox_id = sandbox.get("id")
    if not sandbox_id:
        return

    enriched = attach_runtime_summary(sandbox)
    status = enriched.get("status") or {}
    state = status.get("state")
    wall = (enriched.get("runtimeSummary") or {}).get("wallClockSeconds")
    lifecycle_created = _parse_ts(enriched.get("createdAt"))
    expires = _parse_ts(enriched.get("expiresAt"))
    last_transition = _parse_ts(status.get("lastTransitionAt"))
    ended_at: datetime | None = None
    if state in _TERMINAL and last_transition:
        ended_at = last_transition
    now = datetime.now(timezone.utc)

    with _pool.connection() as conn:
        existing_cr: dict[str, Any] | None = None
        if create_request is None:
            prev = conn.execute(
                "SELECT create_request FROM sandbox_lifecycle_history WHERE sandbox_id = %s",
                (sandbox_id,),
            ).fetchone()
            if prev and prev.get("create_request") is not None:
                raw = prev["create_request"]
                if isinstance(raw, str):
                    try:
                        existing_cr = json.loads(raw)
                    except json.JSONDecodeError:
                        existing_cr = None
                elif isinstance(raw, dict):
                    existing_cr = raw

        merged_create_request = create_request if create_request is not None else existing_cr
        explicit = explicit_resource_limits(enriched, merged_create_request)
        if explicit:
            cpu_limit, memory_limit, cpu_cores, memory_gi = limits_to_numbers(explicit)
        else:
            cpu_limit = memory_limit = None
            cpu_cores = memory_gi = None

        conn.execute(
            """
            INSERT INTO sandbox_lifecycle_history (
                sandbox_id, tenant_name, namespace, state, image_uri,
                lifecycle_created_at, expires_at, ended_at, wall_clock_seconds,
                source, create_request, first_recorded_at, last_seen_at,
                cpu_limit, memory_limit, cpu_cores, memory_gi
            ) VALUES (
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s::jsonb, %s, %s,
                %s, %s, %s, %s
            )
            ON CONFLICT (sandbox_id) DO UPDATE SET
                tenant_name = EXCLUDED.tenant_name,
                namespace = EXCLUDED.namespace,
                state = CASE
                    WHEN sandbox_lifecycle_history.deleted_at IS NOT NULL
                    THEN sandbox_lifecycle_history.state
                    WHEN sandbox_lifecycle_history.state IN ('Terminated', 'Failed')
                    THEN sandbox_lifecycle_history.state
                    ELSE EXCLUDED.state
                END,
                image_uri = COALESCE(EXCLUDED.image_uri, sandbox_lifecycle_history.image_uri),
                lifecycle_created_at = CASE
                    WHEN sandbox_lifecycle_history.deleted_at IS NOT NULL
                        OR sandbox_lifecycle_history.state IN ('Terminated', 'Failed')
                    THEN sandbox_lifecycle_history.lifecycle_created_at
                    ELSE COALESCE(
                        EXCLUDED.lifecycle_created_at,
                        sandbox_lifecycle_history.lifecycle_created_at
                    )
                END,
                expires_at = COALESCE(
                    EXCLUDED.expires_at, sandbox_lifecycle_history.expires_at
                ),
                ended_at = COALESCE(EXCLUDED.ended_at, sandbox_lifecycle_history.ended_at),
                wall_clock_seconds = COALESCE(EXCLUDED.wall_clock_seconds, sandbox_lifecycle_history.wall_clock_seconds),
                last_seen_at = EXCLUDED.last_seen_at,
                create_request = COALESCE(
                    EXCLUDED.create_request, sandbox_lifecycle_history.create_request
                ),
                cpu_limit = COALESCE(EXCLUDED.cpu_limit, sandbox_lifecycle_history.cpu_limit),
                memory_limit = COALESCE(
                    EXCLUDED.memory_limit, sandbox_lifecycle_history.memory_limit
                ),
                cpu_cores = COALESCE(EXCLUDED.cpu_cores, sandbox_lifecycle_history.cpu_cores),
                memory_gi = COALESCE(EXCLUDED.memory_gi, sandbox_lifecycle_history.memory_gi),
                source = CASE
                    WHEN EXCLUDED.source <> 'server-lifecycle' THEN EXCLUDED.source
                    WHEN sandbox_lifecycle_history.source IS NOT NULL
                         AND sandbox_lifecycle_history.source <> 'server-lifecycle'
                    THEN sandbox_lifecycle_history.source
                    ELSE EXCLUDED.source
                END
            """,
            (
                sandbox_id,
                tenant_name,
                namespace,
                state,
                _image_uri(enriched),
                lifecycle_created,
                expires,
                ended_at,
                int(wall) if isinstance(wall, int) else None,
                source,
                json.dumps(create_request) if create_request else None,
                now,
                now,
                cpu_limit,
                memory_limit,
                cpu_cores,
                memory_gi,
            ),
        )


def _row_lifecycle_start(row: dict[str, Any]) -> datetime | None:
    start = row.get("lifecycle_created_at") or row.get("first_recorded_at")
    if isinstance(start, datetime):
        return start.astimezone(timezone.utc)
    return None


def _lifecycle_end_at(
    row: dict[str, Any],
    *,
    period_to: datetime,
    now: datetime,
) -> datetime:
    """End of sandbox lifetime (never extends past destroy/terminate into 'now' unless still active)."""
    for key in ("ended_at", "deleted_at"):
        ts = row.get(key)
        if isinstance(ts, datetime):
            return min(ts.astimezone(timezone.utc), period_to)

    start = _row_lifecycle_start(row)
    state = row.get("state")
    closed = state in _TERMINAL or row.get("deleted_at") is not None
    if closed and start is not None:
        wall = row.get("wall_clock_seconds")
        if isinstance(wall, int) and wall >= 0:
            return min(start + timedelta(seconds=wall), period_to)
        last = row.get("last_seen_at")
        if isinstance(last, datetime):
            return min(last.astimezone(timezone.utc), period_to)

    return min(now, period_to)


def _overlap_seconds_in_period(
    row: dict[str, Any],
    *,
    period_from: datetime,
    period_to: datetime,
    now: datetime,
) -> float:
    """Seconds of sandbox lifetime overlapping [period_from, period_to)."""
    start = row.get("lifecycle_created_at") or row.get("first_recorded_at")
    if not isinstance(start, datetime):
        return 0.0
    start = start.astimezone(timezone.utc)
    end = _lifecycle_end_at(row, period_to=period_to, now=now)
    overlap_start = max(start, period_from)
    overlap_end = min(end, period_to)
    if overlap_end <= overlap_start:
        return 0.0
    return (overlap_end - overlap_start).total_seconds()


def effective_lifecycle_interval(
    row: dict[str, Any],
    *,
    period_from: datetime,
    period_to: datetime,
    now: datetime,
) -> tuple[datetime, datetime] | None:
    """Active sandbox lifetime intersected with [period_from, period_to)."""
    start = _row_lifecycle_start(row)
    if start is None:
        return None
    end = _lifecycle_end_at(row, period_to=period_to, now=now)
    overlap_start = max(start, period_from.astimezone(timezone.utc))
    overlap_end = min(end, period_to.astimezone(timezone.utc))
    if overlap_end <= overlap_start:
        return None
    return overlap_start, overlap_end


def list_recommendation_candidates(
    settings: Settings,
    *,
    tenant_name: str | None,
    period_from: datetime,
    period_to: datetime,
    label: str | None = None,
    sandbox_id: str | None = None,
    max_rows: int = 500,
) -> list[dict[str, Any]]:
    """History rows overlapping the period (includes terminated sandboxes)."""
    if _pool is None:
        return []

    period_from = period_from.astimezone(timezone.utc)
    period_to = period_to.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    where = """
        WHERE COALESCE(h.lifecycle_created_at, h.first_recorded_at) < %s
          AND COALESCE(h.ended_at, h.deleted_at, %s) > %s
    """
    params: list[Any] = [period_to, now, period_from]
    if tenant_name:
        where += " AND h.tenant_name = %s"
        params.append(tenant_name)
    label_sql, label_params = _label_where("h", label)
    where += label_sql
    params.extend(label_params)
    id_sql, id_params = _sandbox_id_where("h", sandbox_id)
    where += id_sql
    params.extend(id_params)

    limit_sql = ""
    if max_rows > 0:
        limit_sql = " LIMIT %s"
        params.append(max_rows + 1)

    with _pool.connection() as conn:
        rows = conn.execute(
            f"SELECT h.* FROM sandbox_lifecycle_history h {where}{limit_sql}",
            params,
        ).fetchall()
    return list(rows)


def _display_wall_clock_seconds(row: dict[str, Any]) -> int | None:
    start = _row_lifecycle_start(row)
    if start is None:
        wall = row.get("wall_clock_seconds")
        return int(wall) if isinstance(wall, int) else None
    for key in ("ended_at", "deleted_at"):
        ts = row.get(key)
        if isinstance(ts, datetime):
            end = ts.astimezone(timezone.utc)
            return max(0, int((end - start).total_seconds()))
    if row.get("deleted_at") or row.get("state") in _TERMINAL:
        wall = row.get("wall_clock_seconds")
        if isinstance(wall, int):
            return wall
    wall = row.get("wall_clock_seconds")
    return int(wall) if isinstance(wall, int) else None


_WALL_CLOCK_FREEZE_SQL = """
    wall_clock_seconds = COALESCE(
        wall_clock_seconds,
        GREATEST(
            0,
            FLOOR(
                EXTRACT(
                    EPOCH FROM (
                        COALESCE(ended_at, %s) - COALESCE(lifecycle_created_at, first_recorded_at)
                    )
                )
            )::int
        )
    )
"""


def mark_deleted(
    settings: Settings,
    sandbox_id: str,
    *,
    tenant_name: str,
    namespace: str,
    final_sandbox: dict[str, Any] | None = None,
) -> None:
    if not settings.bff_history_enabled or _pool is None:
        return
    now = datetime.now(timezone.utc)
    if final_sandbox and tenant_name:
        st = (final_sandbox.get("status") or {}).get("state")
        if st in _TERMINAL:
            upsert_from_sandbox(
                settings,
                tenant_name=tenant_name,
                namespace=namespace,
                sandbox=final_sandbox,
            )
    with _pool.connection() as conn:
        conn.execute(
            """
            UPDATE sandbox_lifecycle_history
            SET
                deleted_at = COALESCE(deleted_at, %s),
                state = 'Terminated',
                ended_at = COALESCE(ended_at, %s),
                last_seen_at = %s,
            """
            + _WALL_CLOCK_FREEZE_SQL
            + """
            WHERE sandbox_id = %s
            """,
            (now, now, now, now, sandbox_id),
        )


def mark_missing_as_terminated(
    settings: Settings,
    *,
    tenant_name: str,
    live_sandbox_ids: set[str],
) -> int:
    """Close history rows that Lifecycle no longer lists.

    A past ``expires_at`` is the end of the sandbox. Refresh time is only a
    fallback when the row has no expiration, or it expired in the future and
    disappeared early. One statement must not stamp every row with ``now``.
    """
    if _pool is None:
        return 0
    now = datetime.now(timezone.utc)
    with _pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT sandbox_id FROM sandbox_lifecycle_history
            WHERE tenant_name = %s
              AND deleted_at IS NULL
              AND (state IS NULL OR state NOT IN ('Terminated', 'Failed', 'Stopping'))
            """,
            (tenant_name,),
        ).fetchall()
        stale = [r["sandbox_id"] for r in rows if r["sandbox_id"] not in live_sandbox_ids]
        if not stale:
            return 0
        conn.execute(
            """
            UPDATE sandbox_lifecycle_history AS h
            SET
                state = 'Terminated',
                ended_at = COALESCE(h.ended_at, v.close_at),
                deleted_at = COALESCE(h.deleted_at, v.close_at),
                last_seen_at = %s,
                wall_clock_seconds = GREATEST(
                    0,
                    FLOOR(
                        EXTRACT(
                            EPOCH FROM (
                                COALESCE(h.ended_at, v.close_at)
                                - COALESCE(h.lifecycle_created_at, h.first_recorded_at)
                            )
                        )
                    )
                )::int
            FROM (
                SELECT
                    sandbox_id,
                    CASE
                        WHEN expires_at IS NOT NULL AND expires_at <= %s THEN expires_at
                        ELSE %s
                    END AS close_at
                FROM sandbox_lifecycle_history
                WHERE tenant_name = %s
                  AND sandbox_id = ANY(%s)
            ) AS v
            WHERE h.sandbox_id = v.sandbox_id
            """,
            (now, now, now, tenant_name, stale),
        )
        return len(stale)


def list_history(
    settings: Settings,
    *,
    tenant_name: str | None,
    page: int,
    page_size: int,
    include_active: bool = True,
    period_from: datetime | None = None,
    period_to: datetime | None = None,
    label: str | None = None,
    sandbox_id: str | None = None,
) -> dict[str, Any]:
    if _pool is None:
        return {"items": [], "pagination": _empty_page(page, page_size)}

    if period_from is not None and period_to is not None:
        period_from = period_from.astimezone(timezone.utc)
        period_to = period_to.astimezone(timezone.utc)
        now = datetime.now(timezone.utc)
        where = "WHERE COALESCE(lifecycle_created_at, first_recorded_at) < %s"
        params: list[Any] = [period_to]
        if tenant_name:
            where += " AND tenant_name = %s"
            params.append(tenant_name)
        with _pool.connection() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    h.*,
                    (SELECT COUNT(*)::int FROM snapshots s WHERE s.source_sandbox_id = h.sandbox_id) AS snapshot_count
                FROM sandbox_lifecycle_history h
                {where}
                """,
                params,
            ).fetchall()
        matched = [
            r
            for r in rows
            if _overlap_seconds_in_period(r, period_from=period_from, period_to=period_to, now=now) > 0
        ]
        if not include_active:
            matched = [
                r
                for r in matched
                if r.get("deleted_at") is not None or r.get("state") in _TERMINAL
            ]
        if label:
            matched = [
                r for r in matched if _metadata_matches_label(_metadata_from_row(r), label)
            ]
        if sandbox_id:
            matched = [
                r
                for r in matched
                if _sandbox_id_matches(str(r.get("sandbox_id") or ""), sandbox_id)
            ]
        def _history_sort_key(row: dict[str, Any]) -> datetime:
            start = row.get("lifecycle_created_at") or row.get("first_recorded_at")
            if isinstance(start, datetime):
                return start.astimezone(timezone.utc)
            return datetime.min.replace(tzinfo=timezone.utc)

        matched.sort(key=_history_sort_key, reverse=True)
        total = len(matched)
        offset = (page - 1) * page_size
        page_rows = matched[offset : offset + page_size]
        items = [_row_to_item(r) for r in page_rows]
        total_pages = max(1, (total + page_size - 1) // page_size) if total else 1
        return {
            "items": items,
            "period": {
                "from": period_from.isoformat().replace("+00:00", "Z"),
                "to": period_to.isoformat().replace("+00:00", "Z"),
            },
            "pagination": {
                "page": page,
                "pageSize": page_size,
                "totalItems": total,
                "totalPages": total_pages,
                "hasNextPage": page < total_pages,
            },
        }

    offset = (page - 1) * page_size
    where = "WHERE 1=1"
    params = []
    if tenant_name:
        where += " AND h.tenant_name = %s"
        params.append(tenant_name)
    if not include_active:
        where += " AND (h.deleted_at IS NOT NULL OR h.state = ANY(%s))"
        params.append(list(_TERMINAL))
    label_sql, label_params = _label_where("h", label)
    where += label_sql
    params.extend(label_params)
    id_sql, id_params = _sandbox_id_where("h", sandbox_id)
    where += id_sql
    params.extend(id_params)

    with _pool.connection() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM sandbox_lifecycle_history h {where}",
            params,
        ).fetchone()["c"]
        rows = conn.execute(
            f"""
            SELECT
                h.*,
                (SELECT COUNT(*)::int FROM snapshots s WHERE s.source_sandbox_id = h.sandbox_id) AS snapshot_count
            FROM sandbox_lifecycle_history h
            {where}
            ORDER BY COALESCE(h.lifecycle_created_at, h.first_recorded_at) DESC
            LIMIT %s OFFSET %s
            """,
            [*params, page_size, offset],
        ).fetchall()

    items = [_row_to_item(r) for r in rows]
    total_pages = max(1, (total + page_size - 1) // page_size)
    return {
        "items": items,
        "pagination": {
            "page": page,
            "pageSize": page_size,
            "totalItems": total,
            "totalPages": total_pages,
            "hasNextPage": page < total_pages,
        },
    }


def get_history_record(
    settings: Settings,
    *,
    sandbox_id: str,
    tenant_name: str | None,
) -> dict[str, Any] | None:
    if _pool is None:
        return None
    where = "WHERE h.sandbox_id = %s"
    params: list[Any] = [sandbox_id]
    if tenant_name:
        where += " AND h.tenant_name = %s"
        params.append(tenant_name)
    with _pool.connection() as conn:
        row = conn.execute(
            f"""
            SELECT
                h.*,
                (SELECT COUNT(*)::int FROM snapshots s WHERE s.source_sandbox_id = h.sandbox_id) AS snapshot_count
            FROM sandbox_lifecycle_history h
            {where}
            """,
            params,
        ).fetchone()
    if not row:
        return None
    return _row_to_item(row)


def _row_counts_as_active(row: dict[str, Any]) -> bool:
    state = row.get("state")
    return row.get("deleted_at") is None and isinstance(state, str) and state not in _TERMINAL


def _pack_history_counts(total: int, active: int, wall: int) -> dict[str, int]:
    return {
        "totalRecords": total,
        "activeRecords": active,
        "totalWallClockSeconds": wall,
        "avgWallClockSeconds": int(wall / total) if total else 0,
    }


def _aggregate_period_history_stats(
    rows: list[dict[str, Any]],
    *,
    period_from: datetime,
    period_to: datetime,
    now: datetime,
) -> dict[str, Any]:
    """Records whose lifetime overlaps [period_from, period_to); duration is clipped to that window."""
    buckets: dict[str, dict[str, int]] = {}
    for row in rows:
        seconds = _overlap_seconds_in_period(row, period_from=period_from, period_to=period_to, now=now)
        if seconds <= 0:
            continue
        tenant = str(row.get("tenant_name") or "")
        bucket = buckets.setdefault(tenant, {"total": 0, "active": 0, "wall": 0})
        bucket["total"] += 1
        bucket["wall"] += int(seconds)
        if _row_counts_as_active(row):
            bucket["active"] += 1

    tenants = [
        {"tenant": name, **_pack_history_counts(bucket["total"], bucket["active"], bucket["wall"])}
        for name, bucket in buckets.items()
    ]
    tenants.sort(key=lambda item: (-int(item["totalRecords"]), str(item["tenant"])))
    return {
        **_pack_history_counts(
            sum(bucket["total"] for bucket in buckets.values()),
            sum(bucket["active"] for bucket in buckets.values()),
            sum(bucket["wall"] for bucket in buckets.values()),
        ),
        "tenants": tenants,
    }


_CREATED_SERIES_TRIM_AFTER = 36
_CREATED_DAY_SPAN_LIMIT = timedelta(days=120)


def _series_created_at(row: dict[str, Any]) -> datetime | None:
    raw = row.get("created_at")
    if raw is None:
        raw = row.get("lifecycle_created_at")
    if raw is None:
        raw = row.get("first_recorded_at")
    if not isinstance(raw, datetime):
        return None
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    return raw.astimezone(timezone.utc)


def _validate_created_bucket(bucket: str, period_from: datetime, period_to: datetime) -> str:
    kind = bucket.strip().lower()
    if kind not in ("day", "month"):
        raise ValueError("bucket must be day or month")
    start = period_from if period_from.tzinfo else period_from.replace(tzinfo=timezone.utc)
    end = period_to if period_to.tzinfo else period_to.replace(tzinfo=timezone.utc)
    if kind == "day" and end - start > _CREATED_DAY_SPAN_LIMIT:
        raise ValueError("day bucket supports at most 120 days")
    return kind


def _created_bucket_starts(period_from: datetime, period_to: datetime, bucket: str) -> list[datetime]:
    start = period_from.astimezone(timezone.utc)
    end = period_to.astimezone(timezone.utc)
    if bucket == "month":
        cursor = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        cursor = start.replace(hour=0, minute=0, second=0, microsecond=0)
    points: list[datetime] = []
    while cursor < end:
        points.append(cursor)
        if bucket == "month":
            year = cursor.year + (1 if cursor.month == 12 else 0)
            month = 1 if cursor.month == 12 else cursor.month + 1
            cursor = cursor.replace(year=year, month=month)
        else:
            cursor = cursor + timedelta(days=1)
    return points


def _aggregate_created_series(
    rows: list[dict[str, Any]],
    *,
    period_from: datetime,
    period_to: datetime,
    bucket: str,
) -> dict[str, Any]:
    """Count sandboxes by UTC create time. `period_to` is exclusive."""
    bucket = _validate_created_bucket(bucket, period_from, period_to)
    period_from = period_from.astimezone(timezone.utc)
    period_to = period_to.astimezone(timezone.utc)
    starts = _created_bucket_starts(period_from, period_to, bucket)
    labels = [start.strftime("%Y-%m" if bucket == "month" else "%Y-%m-%d") for start in starts]
    index = {label: i for i, label in enumerate(labels)}
    by_tenant: dict[str, list[int]] = {}
    for row in rows:
        created = _series_created_at(row)
        if created is None or created < period_from or created >= period_to:
            continue
        label = created.strftime("%Y-%m" if bucket == "month" else "%Y-%m-%d")
        slot = index.get(label)
        if slot is None:
            continue
        tenant = str(row.get("tenant_name") or "")
        counts = by_tenant.get(tenant)
        if counts is None:
            counts = [0] * len(labels)
            by_tenant[tenant] = counts
        counts[slot] += 1

    if len(labels) > _CREATED_SERIES_TRIM_AFTER:
        first = 0
        while first < len(labels) and all(counts[first] == 0 for counts in by_tenant.values()):
            first += 1
        if first:
            labels = labels[first:]
            for tenant, counts in by_tenant.items():
                by_tenant[tenant] = counts[first:]

    series = [{"tenant": name, "counts": counts} for name, counts in by_tenant.items()]
    series.sort(key=lambda item: (-sum(item["counts"]), str(item["tenant"])))
    totals = [0] * len(labels)
    for item in series:
        for i, count in enumerate(item["counts"]):
            totals[i] += int(count)
    return {"points": labels, "series": series, "totals": totals}


def created_series(
    settings: Settings,
    *,
    tenant_name: str | None,
    period_from: datetime,
    period_to: datetime,
    bucket: str,
) -> dict[str, Any]:
    """Sandbox create counts in [period_from, period_to), bucketed by UTC day or month."""
    if _pool is None:
        return {"enabled": False}
    period_from = period_from.astimezone(timezone.utc)
    period_to = period_to.astimezone(timezone.utc)
    if period_to <= period_from:
        raise ValueError("period to must be after from")
    bucket = _validate_created_bucket(bucket, period_from, period_to)
    where = (
        "WHERE COALESCE(lifecycle_created_at, first_recorded_at) >= %s "
        "AND COALESCE(lifecycle_created_at, first_recorded_at) < %s"
    )
    params: list[Any] = [period_from, period_to]
    if tenant_name:
        where += " AND tenant_name = %s"
        params.append(tenant_name)
    with _pool.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT
                tenant_name,
                COALESCE(lifecycle_created_at, first_recorded_at) AS created_at
            FROM sandbox_lifecycle_history
            {where}
            """,
            params,
        ).fetchall()
    aggregated = _aggregate_created_series(
        list(rows),
        period_from=period_from,
        period_to=period_to,
        bucket=bucket,
    )
    now = datetime.now(timezone.utc)
    return {
        "enabled": True,
        "asOf": now.isoformat().replace("+00:00", "Z"),
        "bucket": bucket,
        "period": {
            "from": period_from.isoformat().replace("+00:00", "Z"),
            "to": period_to.isoformat().replace("+00:00", "Z"),
        },
        **aggregated,
    }


def history_stats(
    settings: Settings,
    *,
    tenant_name: str | None,
    period_from: datetime | None = None,
    period_to: datetime | None = None,
) -> dict[str, Any]:
    if _pool is None:
        return {"enabled": False}
    if period_from is not None and period_to is not None:
        period_from = period_from.astimezone(timezone.utc)
        period_to = period_to.astimezone(timezone.utc)
        now = datetime.now(timezone.utc)
        where = "WHERE COALESCE(lifecycle_created_at, first_recorded_at) < %s"
        params: list[Any] = [period_to]
        if tenant_name:
            where += " AND tenant_name = %s"
            params.append(tenant_name)
        with _pool.connection() as conn:
            rows = conn.execute(
                f"""
                SELECT
                    tenant_name, state, deleted_at, ended_at,
                    lifecycle_created_at, first_recorded_at,
                    wall_clock_seconds, last_seen_at
                FROM sandbox_lifecycle_history
                {where}
                """,
                params,
            ).fetchall()
        aggregated = _aggregate_period_history_stats(
            list(rows),
            period_from=period_from,
            period_to=period_to,
            now=now,
        )
        return {
            "enabled": True,
            "asOf": now.isoformat().replace("+00:00", "Z"),
            "period": {
                "from": period_from.isoformat().replace("+00:00", "Z"),
                "to": period_to.isoformat().replace("+00:00", "Z"),
            },
            **aggregated,
        }

    where = ""
    params = []
    if tenant_name:
        where = "WHERE tenant_name = %s"
        params.append(tenant_name)
    with _pool.connection() as conn:
        row = conn.execute(
            f"""
            SELECT
                COUNT(*)::int AS total_records,
                COUNT(*) FILTER (WHERE deleted_at IS NULL AND state NOT IN ('Terminated','Failed','Stopping'))::int AS active_records,
                COALESCE(SUM(wall_clock_seconds) FILTER (WHERE wall_clock_seconds IS NOT NULL), 0)::bigint AS total_wall_clock_seconds,
                COALESCE(AVG(wall_clock_seconds) FILTER (WHERE wall_clock_seconds IS NOT NULL), 0)::int AS avg_wall_clock_seconds
            FROM sandbox_lifecycle_history
            {where}
            """,
            params,
        ).fetchone()
        tenant_rows = conn.execute(
            f"""
            SELECT
                tenant_name,
                COUNT(*)::int AS total_records,
                COUNT(*) FILTER (WHERE deleted_at IS NULL AND state NOT IN ('Terminated','Failed','Stopping'))::int AS active_records,
                COALESCE(SUM(wall_clock_seconds) FILTER (WHERE wall_clock_seconds IS NOT NULL), 0)::bigint AS total_wall_clock_seconds,
                COALESCE(AVG(wall_clock_seconds) FILTER (WHERE wall_clock_seconds IS NOT NULL), 0)::int AS avg_wall_clock_seconds
            FROM sandbox_lifecycle_history
            {where}
            GROUP BY tenant_name
            ORDER BY total_records DESC, tenant_name ASC
            """,
            params,
        ).fetchall()
    return {
        "enabled": True,
        "asOf": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "totalRecords": int(row["total_records"]),
        "activeRecords": int(row["active_records"]),
        "totalWallClockSeconds": int(row["total_wall_clock_seconds"]),
        "avgWallClockSeconds": int(row["avg_wall_clock_seconds"]),
        "tenants": [
            {
                "tenant": str(item["tenant_name"] or ""),
                "totalRecords": int(item["total_records"]),
                "activeRecords": int(item["active_records"]),
                "totalWallClockSeconds": int(item["total_wall_clock_seconds"]),
                "avgWallClockSeconds": int(item["avg_wall_clock_seconds"]),
            }
            for item in tenant_rows
        ],
    }


_UNKNOWN_IMAGE_LABEL = "(未记录镜像)"


def image_stats(
    settings: Settings,
    *,
    tenant_name: str | None,
    period_from: datetime | None = None,
    period_to: datetime | None = None,
) -> dict[str, Any]:
    """Aggregate sandbox counts by base image URI from sandbox_lifecycle_history."""
    if _pool is None:
        return {"enabled": False, "items": []}
    where_parts = ["1=1"]
    params: list[Any] = []
    if tenant_name:
        where_parts.append("tenant_name = %s")
        params.append(tenant_name)
    if period_from is not None:
        where_parts.append("COALESCE(lifecycle_created_at, first_recorded_at) >= %s")
        params.append(period_from)
    if period_to is not None:
        where_parts.append("COALESCE(lifecycle_created_at, first_recorded_at) < %s")
        params.append(period_to)
    where_sql = " AND ".join(where_parts)

    with _pool.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(image_uri), ''), %s) AS image_uri,
                COUNT(*)::int AS sandbox_count,
                COUNT(*) FILTER (
                    WHERE deleted_at IS NULL
                      AND (state IS NULL OR state NOT IN ('Terminated','Failed','Stopping'))
                )::int AS active_count,
                COUNT(DISTINCT tenant_name)::int AS tenant_count,
                MAX(COALESCE(lifecycle_created_at, first_recorded_at)) AS last_used_at
            FROM sandbox_lifecycle_history
            WHERE {where_sql}
            GROUP BY 1
            ORDER BY sandbox_count DESC, image_uri ASC
            """,
            [_UNKNOWN_IMAGE_LABEL, *params],
        ).fetchall()

    total = sum(int(r["sandbox_count"]) for r in rows)

    def iso_dt(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return str(v)

    items: list[dict[str, Any]] = []
    for row in rows:
        count = int(row["sandbox_count"])
        items.append(
            {
                "imageUri": row["image_uri"],
                "sandboxCount": count,
                "activeCount": int(row["active_count"]),
                "tenantCount": int(row["tenant_count"]),
                "sharePercent": round(count / total * 100, 2) if total else 0.0,
                "lastUsedAt": iso_dt(row["last_used_at"]),
            }
        )

    return {
        "enabled": True,
        "asOf": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "totalRecords": total,
        "distinctImages": len(items),
        "items": items,
    }


def _explicit_cpu_memory(row: dict[str, Any]) -> tuple[float | None, float | None]:
    """CPU cores and memory Gi from stored columns or create-time limits.

    Missing limits stay missing. Usage must not substitute the 1 core / 512Mi display default.
    """
    cpu_col = row.get("cpu_cores")
    mem_col = row.get("memory_gi")
    cpu = float(cpu_col) if cpu_col is not None else None
    mem = float(mem_col) if mem_col is not None else None
    if cpu is not None and mem is not None:
        return cpu, mem
    cr = row.get("create_request")
    if isinstance(cr, str):
        try:
            cr = json.loads(cr)
        except json.JSONDecodeError:
            cr = None
    explicit = explicit_resource_limits({}, cr if isinstance(cr, dict) else None)
    if explicit:
        if cpu is None and explicit.get("cpu"):
            cpu = parse_cpu_cores(str(explicit["cpu"]))
        if mem is None and explicit.get("memory"):
            mem = parse_memory_gi(str(explicit["memory"]))
    return cpu, mem


def usage_allocation(
    settings: Settings,
    *,
    period_from: datetime,
    period_to: datetime,
    display_tenant: str | None = None,
    viewer_tenant_only: str | None = None,
) -> dict[str, Any]:
    """Aggregate tenant usage in [period_from, period_to) using resource limits."""
    if _pool is None:
        return {"enabled": False}
    if period_to <= period_from:
        raise ValueError("period to must be after from")

    period_from = period_from.astimezone(timezone.utc)
    period_to = period_to.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)

    with _pool.connection() as conn:
        rows = conn.execute(
            """
            SELECT
                sandbox_id, tenant_name, state,
                lifecycle_created_at, first_recorded_at,
                ended_at, deleted_at, last_seen_at, wall_clock_seconds,
                cpu_cores, memory_gi, create_request
            FROM sandbox_lifecycle_history
            WHERE COALESCE(lifecycle_created_at, first_recorded_at) < %s
            """,
            (period_to,),
        ).fetchall()

    by_tenant: dict[str, dict[str, float | int]] = {}

    def bucket(t: str) -> dict[str, float | int]:
        if t not in by_tenant:
            by_tenant[t] = {
                "sandboxCount": 0,
                "overlapSeconds": 0.0,
                "cpuCoreSeconds": 0.0,
                "memoryGiSeconds": 0.0,
                "limitsMissing": 0,
            }
        return by_tenant[t]

    for row in rows:
        seconds = _overlap_seconds_in_period(row, period_from=period_from, period_to=period_to, now=now)
        if seconds <= 0:
            continue
        cpu, mem = _explicit_cpu_memory(row)
        t = str(row["tenant_name"])
        b = bucket(t)
        b["sandboxCount"] = int(b["sandboxCount"]) + 1
        b["overlapSeconds"] = float(b["overlapSeconds"]) + seconds
        if cpu is None or mem is None:
            b["limitsMissing"] = int(b["limitsMissing"]) + 1
        if cpu is not None:
            b["cpuCoreSeconds"] = float(b["cpuCoreSeconds"]) + cpu * seconds
        if mem is not None:
            b["memoryGiSeconds"] = float(b["memoryGiSeconds"]) + mem * seconds

    cluster_totals = {
        "sandboxCount": 0,
        "overlapSeconds": 0.0,
        "cpuCoreSeconds": 0.0,
        "memoryGiSeconds": 0.0,
        "limitsMissing": 0,
    }
    for b in by_tenant.values():
        cluster_totals["sandboxCount"] += int(b["sandboxCount"])
        cluster_totals["overlapSeconds"] += float(b["overlapSeconds"])
        cluster_totals["cpuCoreSeconds"] += float(b["cpuCoreSeconds"])
        cluster_totals["memoryGiSeconds"] += float(b["memoryGiSeconds"])
        cluster_totals["limitsMissing"] += int(b["limitsMissing"])

    def _tenant_in_scope(tenant: str) -> bool:
        if viewer_tenant_only and tenant != viewer_tenant_only:
            return False
        if display_tenant and tenant != display_tenant:
            return False
        return True

    totals = {
        "sandboxCount": 0,
        "overlapSeconds": 0.0,
        "cpuCoreSeconds": 0.0,
        "memoryGiSeconds": 0.0,
        "limitsMissing": 0,
    }
    for t, b in by_tenant.items():
        if not _tenant_in_scope(t):
            continue
        totals["sandboxCount"] += int(b["sandboxCount"])
        totals["overlapSeconds"] += float(b["overlapSeconds"])
        totals["cpuCoreSeconds"] += float(b["cpuCoreSeconds"])
        totals["memoryGiSeconds"] += float(b["memoryGiSeconds"])
        totals["limitsMissing"] += int(b["limitsMissing"])

    def pct(part: float, whole: float) -> float:
        if whole <= 0:
            return 0.0
        return round(100.0 * part / whole, 2)

    def composite_share_pct(b: dict[str, float | int]) -> float:
        """Equal-weight mean of time / CPU / memory shares (each sums to 100% cluster-wide)."""
        terms: list[float] = []
        for key in ("overlapSeconds", "cpuCoreSeconds", "memoryGiSeconds"):
            whole = float(cluster_totals[key])
            if whole > 0:
                terms.append(float(b[key]) / whole)
        if not terms:
            return 0.0
        return round(100.0 * sum(terms) / len(terms), 2)

    tenants_out: list[dict[str, Any]] = []
    for t, b in sorted(by_tenant.items(), key=lambda x: (-float(x[1]["overlapSeconds"]), x[0])):
        if viewer_tenant_only and t != viewer_tenant_only:
            continue
        if display_tenant and t != display_tenant:
            continue
        tenants_out.append(
            {
                "tenant": t,
                "sandboxCount": int(b["sandboxCount"]),
                "overlapSeconds": int(round(float(b["overlapSeconds"]))),
                "cpuCoreSeconds": round(float(b["cpuCoreSeconds"]), 2),
                "memoryGiSeconds": round(float(b["memoryGiSeconds"]), 2),
                "sharePercent": {
                    "time": pct(float(b["overlapSeconds"]), float(cluster_totals["overlapSeconds"])),
                    "cpu": pct(float(b["cpuCoreSeconds"]), float(cluster_totals["cpuCoreSeconds"])),
                    "memory": pct(float(b["memoryGiSeconds"]), float(cluster_totals["memoryGiSeconds"])),
                    "composite": composite_share_pct(b),
                },
            }
        )

    def iso(dt: datetime) -> str:
        return dt.isoformat().replace("+00:00", "Z")

    return {
        "enabled": True,
        "basis": "resourceLimits",
        "coverageNote": (
            "沙箱数 = 与统计区间有生命周期交集的 history 条数（与占用时长同一批实例，非实时列表、非申请历史总条数）。"
            "占用时长 = 各沙箱「创建→结束」与区间的交集秒数之和（结束取 ended_at/deleted_at 或已终止 wall_clock，"
            "不会把已销毁沙箱延续到当前时间）。没有创建时 resourceLimits 的记录仍计入沙箱数和占用时长，"
            "但不计入 CPU·秒和内存·Gi·秒（不会填 1 核 / 512Mi）。统计 sandbox_lifecycle_history 单表（Server 审计 + Console 扩展）。"
        ),
        "shareFormula": {
            "time": "时长占比 = 租户占用秒数 ÷ 区间全集群占用秒数 × 100%",
            "cpu": "CPU 占比 = 租户 CPU·秒 ÷ 全集群 CPU·秒 × 100%（CPU·秒 = Σ limits.cpu × 占用秒）",
            "memory": "内存占比 = 租户内存·Gi·秒 ÷ 全集群内存·Gi·秒 × 100%",
            "composite": (
                "综合分摊占比 = 平均(时长占比, CPU占比, 内存占比) 的小数形式后再 ×100，"
                "即 (T_i/T_tot + C_i/C_tot + M_i/M_tot) / k × 100%，k 为分母>0 的维度数（通常为 3）。"
                "各租户 composite 之和为 100%。后续可改为按核/Gi 单价加权。"
            ),
        },
        "period": {"from": iso(period_from), "to": iso(period_to)},
        "totals": {
            "sandboxCount": totals["sandboxCount"],
            "overlapSeconds": int(round(totals["overlapSeconds"])),
            "cpuCoreSeconds": round(totals["cpuCoreSeconds"], 2),
            "memoryGiSeconds": round(totals["memoryGiSeconds"], 2),
            "limitsMissing": int(totals["limitsMissing"]),
        },
        "tenants": tenants_out,
    }


def _limits_payload(row: dict[str, Any]) -> dict[str, Any]:
    """Expose create-time resourceLimits from history columns + stored create_request."""
    limits: dict[str, str] = {}
    if row.get("cpu_limit"):
        limits["cpu"] = str(row["cpu_limit"])
    if row.get("memory_limit"):
        limits["memory"] = str(row["memory_limit"])

    create_request = row.get("create_request")
    if isinstance(create_request, str):
        try:
            create_request = json.loads(create_request)
        except json.JSONDecodeError:
            create_request = None

    requests: dict[str, str] | None = None
    timeout: int | None = None
    if isinstance(create_request, dict):
        rl = create_request.get("resourceLimits")
        if isinstance(rl, dict):
            for key, val in rl.items():
                if val is not None:
                    limits[str(key)] = str(val)
        rr = create_request.get("resourceRequests")
        if isinstance(rr, dict) and rr:
            requests = {str(k): str(v) for k, v in rr.items() if v is not None}
        raw_timeout = create_request.get("timeout")
        if isinstance(raw_timeout, (int, float)):
            timeout = int(raw_timeout)

    payload: dict[str, Any] = {}
    if limits:
        payload["resourceLimits"] = limits
        _, _, cpu_from_limits, mem_from_limits = limits_to_numbers(limits)
        payload["cpuCores"] = cpu_from_limits
        payload["memoryGi"] = mem_from_limits
    elif row.get("cpu_cores") is not None and row.get("memory_gi") is not None:
        payload["cpuCores"] = float(row["cpu_cores"])
        payload["memoryGi"] = float(row["memory_gi"])
    if requests:
        payload["resourceRequests"] = requests
    if timeout is not None:
        payload["createTimeoutSeconds"] = timeout
    return payload


def _row_to_item(row: dict[str, Any]) -> dict[str, Any]:
    def iso(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            return v.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return str(v)

    raw_state = row["state"]
    if row.get("deleted_at") and raw_state not in _TERMINAL:
        raw_state = "Terminated"

    return {
        "sandboxId": row["sandbox_id"],
        "tenant": row["tenant_name"],
        "namespace": row["namespace"],
        "state": raw_state,
        "imageUri": row["image_uri"],
        "createdAt": iso(row["lifecycle_created_at"]),
        "expiresAt": iso(row["expires_at"]),
        "endedAt": iso(row["ended_at"]),
        "wallClockSeconds": _display_wall_clock_seconds(row),
        "deletedAt": iso(row["deleted_at"]),
        "firstRecordedAt": iso(row["first_recorded_at"]),
        "lastSeenAt": iso(row["last_seen_at"]),
        "source": row["source"],
        "snapshotCount": row.get("snapshot_count", 0),
        "metadata": _metadata_from_row(row),
        **_limits_payload(row),
    }


def _empty_page(page: int, page_size: int) -> dict[str, Any]:
    return {
        "page": page,
        "pageSize": page_size,
        "totalItems": 0,
        "totalPages": 1,
        "hasNextPage": False,
    }


def _recommendation_run_to_item(row: dict[str, Any]) -> dict[str, Any]:
    result = row.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = {}
    if not isinstance(result, dict):
        result = {}
    period_from = row.get("period_from")
    period_to = row.get("period_to")
    created_at = row.get("created_at")
    return {
        "id": row["id"],
        "tenant": row.get("tenant_name"),
        "label": row.get("label") or "",
        "sandboxIdFilter": row.get("sandbox_id_filter") or "",
        "windowLabel": row.get("window_label") or "",
        "period": {
            "from": period_from.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if isinstance(period_from, datetime)
            else None,
            "to": period_to.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if isinstance(period_to, datetime)
            else None,
        },
        "createdByRole": row.get("created_by_role"),
        "createdByActor": row.get("created_by_actor") or "",
        "createdAt": created_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if isinstance(created_at, datetime)
        else None,
        "requests": result.get("requests"),
        "limits": result.get("limits"),
        "sampleCount": result.get("sampleCount"),
        "sandboxCount": result.get("sandboxCount"),
        "sandboxCountWithMetrics": result.get("sandboxCountWithMetrics"),
        "percentile": result.get("percentile"),
    }


def insert_recommendation_run(
    settings: Settings,
    *,
    tenant_name: str | None,
    created_by_role: str,
    created_by_actor: str,
    label: str | None,
    sandbox_id_filter: str | None,
    period_from: datetime,
    period_to: datetime,
    window_label: str | None,
    result: dict[str, Any],
) -> dict[str, Any]:
    del settings
    if _pool is None:
        raise RuntimeError("History database is not available")
    run_id = str(uuid.uuid4())
    period_from = period_from.astimezone(timezone.utc)
    period_to = period_to.astimezone(timezone.utc)
    with _pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO sandbox_resource_recommendation_runs (
                id, tenant_name, created_by_role, created_by_actor,
                label, sandbox_id_filter, period_from, period_to, window_label, result
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            RETURNING *
            """,
            (
                run_id,
                tenant_name,
                created_by_role,
                created_by_actor,
                label,
                sandbox_id_filter,
                period_from,
                period_to,
                window_label,
                json.dumps(result),
            ),
        ).fetchone()
    if not row:
        raise RuntimeError("Failed to insert recommendation run")
    item = _recommendation_run_to_item(row)
    return {**item, "result": result}


def list_recommendation_runs(
    settings: Settings,
    *,
    tenant_name: str | None,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    del settings
    if _pool is None:
        return {"items": [], "pagination": _empty_page(page, page_size)}

    where = "WHERE 1=1"
    params: list[Any] = []
    if tenant_name:
        where += " AND tenant_name = %s"
        params.append(tenant_name)

    offset = (page - 1) * page_size
    with _pool.connection() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM sandbox_resource_recommendation_runs {where}",
            params,
        ).fetchone()["c"]
        rows = conn.execute(
            f"""
            SELECT * FROM sandbox_resource_recommendation_runs
            {where}
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
            """,
            [*params, page_size, offset],
        ).fetchall()

    total_items = int(total)
    total_pages = max(1, (total_items + page_size - 1) // page_size) if total_items else 1
    return {
        "items": [_recommendation_run_to_item(r) for r in rows],
        "pagination": {
            "page": page,
            "pageSize": page_size,
            "totalItems": total_items,
            "totalPages": total_pages,
            "hasNextPage": page < total_pages,
        },
    }


def get_recommendation_run(
    settings: Settings,
    *,
    run_id: str,
    tenant_name: str | None,
) -> dict[str, Any] | None:
    del settings
    if _pool is None:
        return None
    with _pool.connection() as conn:
        row = conn.execute(
            "SELECT * FROM sandbox_resource_recommendation_runs WHERE id = %s",
            (run_id,),
        ).fetchone()
    if not row:
        return None
    if tenant_name and row.get("tenant_name") != tenant_name:
        return None
    result = row.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            result = {}
    item = _recommendation_run_to_item(row)
    return {**item, "result": result if isinstance(result, dict) else {}}
