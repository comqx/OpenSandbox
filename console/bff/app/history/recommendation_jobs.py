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
import logging
from datetime import datetime

from app.config import get_settings
from app.history import reconcile, store
from app.resource_recommendation import RecommendationError, compute_resource_recommendations
from app.tenants import TenantRecord

logger = logging.getLogger(__name__)


async def _record_failure(run_id: str, code: str, message: str) -> None:
    try:
        await asyncio.to_thread(
            store.fail_recommendation_run,
            get_settings(),
            run_id=run_id,
            error_code=code,
            error_message=message,
        )
    except Exception:
        logger.exception("failed to record recommendation run error for %s", run_id)


async def execute_recommendation_run(
    *,
    run_id: str,
    tenant_name: str | None,
    period_from: datetime,
    period_to: datetime,
    label: str | None,
    sandbox_id: str | None,
    reconcile_tenants: list[TenantRecord] | None,
) -> None:
    """Compute one saved recommendation run and persist success or failure."""
    settings = get_settings()
    try:
        await asyncio.to_thread(store.mark_recommendation_run_running, settings, run_id=run_id)
        if reconcile_tenants is not None:
            await reconcile.sync_with_lifecycle(settings, tenants=reconcile_tenants)
        result = await asyncio.to_thread(
            compute_resource_recommendations,
            settings,
            tenant_name=tenant_name,
            period_from=period_from,
            period_to=period_to,
            label=label,
            sandbox_id=sandbox_id,
        )
        await asyncio.to_thread(
            store.complete_recommendation_run,
            settings,
            run_id=run_id,
            result=result,
        )
    except RecommendationError as exc:
        logger.info("recommendation run %s failed: %s %s", run_id, exc.code, exc.message)
        await _record_failure(run_id, exc.code, exc.message)
    except Exception:
        logger.exception("recommendation run %s failed", run_id)
        await _record_failure(run_id, "INTERNAL_ERROR", "Recommendation compute failed")
