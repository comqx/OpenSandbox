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

from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from app.history import recommendation_jobs as jobs
from app.resource_recommendation import RecommendationError


def _period():
    return (
        datetime(2026, 10, 1, tzinfo=timezone.utc),
        datetime(2026, 10, 8, tzinfo=timezone.utc),
    )


@pytest.mark.asyncio
async def test_execute_recommendation_run_persists_success(monkeypatch: pytest.MonkeyPatch) -> None:
    saved: dict = {}
    period_from, period_to = _period()

    monkeypatch.setattr(jobs, "get_settings", lambda: MagicMock())
    monkeypatch.setattr(
        jobs.store,
        "mark_recommendation_run_running",
        lambda _settings, *, run_id: saved.setdefault("running", run_id),
    )
    monkeypatch.setattr(
        jobs,
        "compute_resource_recommendations",
        lambda *_args, **_kwargs: {"requests": {"cpu": "100m"}},
    )
    monkeypatch.setattr(
        jobs.store,
        "complete_recommendation_run",
        lambda _settings, *, run_id, result: saved.update(completed=run_id, result=result),
    )

    await jobs.execute_recommendation_run(
        run_id="run-1",
        tenant_name="t1",
        period_from=period_from,
        period_to=period_to,
        label=None,
        sandbox_id=None,
        reconcile_tenants=None,
    )

    assert saved["running"] == "run-1"
    assert saved["completed"] == "run-1"
    assert saved["result"]["requests"]["cpu"] == "100m"


@pytest.mark.asyncio
async def test_execute_recommendation_run_records_recommendation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saved: dict = {}
    period_from, period_to = _period()

    monkeypatch.setattr(jobs, "get_settings", lambda: MagicMock())
    monkeypatch.setattr(jobs.store, "mark_recommendation_run_running", lambda *_args, **_kwargs: None)

    def compute(*_args, **_kwargs):
        raise RecommendationError("INSUFFICIENT_DATA", "need more sandboxes")

    monkeypatch.setattr(jobs, "compute_resource_recommendations", compute)
    monkeypatch.setattr(
        jobs.store,
        "fail_recommendation_run",
        lambda _settings, *, run_id, error_code, error_message: saved.update(
            run_id=run_id, error_code=error_code, error_message=error_message
        ),
    )

    await jobs.execute_recommendation_run(
        run_id="run-2",
        tenant_name=None,
        period_from=period_from,
        period_to=period_to,
        label="env=dev",
        sandbox_id=None,
        reconcile_tenants=None,
    )

    assert saved == {
        "run_id": "run-2",
        "error_code": "INSUFFICIENT_DATA",
        "error_message": "need more sandboxes",
    }


@pytest.mark.asyncio
async def test_execute_recommendation_run_records_unexpected_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    saved: dict = {}
    period_from, period_to = _period()

    monkeypatch.setattr(jobs, "get_settings", lambda: MagicMock())
    monkeypatch.setattr(jobs.store, "mark_recommendation_run_running", lambda *_args, **_kwargs: None)

    def compute(*_args, **_kwargs):
        raise RuntimeError("prometheus down")

    monkeypatch.setattr(jobs, "compute_resource_recommendations", compute)
    monkeypatch.setattr(
        jobs.store,
        "fail_recommendation_run",
        lambda _settings, *, run_id, error_code, error_message: saved.update(
            error_code=error_code, error_message=error_message
        ),
    )

    await jobs.execute_recommendation_run(
        run_id="run-3",
        tenant_name="t1",
        period_from=period_from,
        period_to=period_to,
        label=None,
        sandbox_id="sbx",
        reconcile_tenants=None,
    )

    assert saved["error_code"] == "INTERNAL_ERROR"
    assert saved["error_message"] == "Recommendation compute failed"
