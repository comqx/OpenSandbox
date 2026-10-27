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

from app.history import store


def test_list_recommendation_runs_without_pool():
    out = store.list_recommendation_runs(MagicMock(), tenant_name="t1", page=1, page_size=20)
    assert out["items"] == []
    assert out["pagination"]["totalItems"] == 0


def _run_row(**overrides):
    row = {
        "id": "run-1",
        "tenant_name": "t1",
        "label": "team=a",
        "sandbox_id_filter": "",
        "window_label": "7d",
        "period_from": datetime(2026, 10, 1, tzinfo=timezone.utc),
        "period_to": datetime(2026, 10, 8, tzinfo=timezone.utc),
        "created_by_role": "tenant",
        "created_by_actor": "t1",
        "created_at": datetime(2026, 10, 8, 1, tzinfo=timezone.utc),
        "finished_at": None,
        "status": "pending",
        "error_code": None,
        "error_message": None,
        "result": {},
    }
    row.update(overrides)
    return row


def test_recommendation_run_item_exposes_async_status():
    item = store._recommendation_run_to_item(_run_row())
    assert item["status"] == "pending"
    assert item["errorCode"] == ""
    assert item["errorMessage"] == ""
    assert item["finishedAt"] is None

    failed = store._recommendation_run_to_item(
        _run_row(
            status="failed",
            error_code="INSUFFICIENT_DATA",
            error_message="not enough sandboxes",
            finished_at=datetime(2026, 10, 8, 2, tzinfo=timezone.utc),
        )
    )
    assert failed["status"] == "failed"
    assert failed["errorCode"] == "INSUFFICIENT_DATA"
    assert failed["errorMessage"] == "not enough sandboxes"
    assert failed["finishedAt"] == "2026-10-08T02:00:00Z"


def test_recommendation_run_item_defaults_missing_status_to_succeeded():
    row = _run_row()
    del row["status"]
    item = store._recommendation_run_to_item(row)
    assert item["status"] == "succeeded"
