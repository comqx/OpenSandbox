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

from app.history.store import _aggregate_period_history_stats, _explicit_cpu_memory


def test_period_history_stats_keeps_overlap_and_splits_tenants():
    now = datetime(2026, 10, 12, tzinfo=timezone.utc)
    period_from = datetime(2026, 10, 1, tzinfo=timezone.utc)
    period_to = datetime(2026, 11, 1, tzinfo=timezone.utc)
    rows = [
        {
            "tenant_name": "alpha",
            "state": "Terminated",
            "deleted_at": datetime(2026, 10, 2, tzinfo=timezone.utc),
            "ended_at": datetime(2026, 10, 2, tzinfo=timezone.utc),
            "lifecycle_created_at": datetime(2026, 10, 1, tzinfo=timezone.utc),
            "wall_clock_seconds": 86400,
        },
        {
            "tenant_name": "alpha",
            "state": "Running",
            "deleted_at": None,
            "lifecycle_created_at": datetime(2026, 10, 11, tzinfo=timezone.utc),
        },
        {
            "tenant_name": "beta",
            "state": "Terminated",
            "deleted_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "ended_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "lifecycle_created_at": datetime(2026, 8, 1, tzinfo=timezone.utc),
            "wall_clock_seconds": 100,
        },
        {
            "tenant_name": "beta",
            "state": "Terminated",
            "deleted_at": datetime(2026, 10, 3, tzinfo=timezone.utc),
            "ended_at": datetime(2026, 10, 3, tzinfo=timezone.utc),
            "lifecycle_created_at": datetime(2026, 9, 30, tzinfo=timezone.utc),
            "wall_clock_seconds": 259200,
        },
    ]

    stats = _aggregate_period_history_stats(
        rows,
        period_from=period_from,
        period_to=period_to,
        now=now,
    )

    assert stats["totalRecords"] == 3
    assert stats["activeRecords"] == 1
    # alpha terminated: 1 day; alpha running: Oct 11 -> Oct 12; beta: Sep 30 -> Oct 3 clipped to Oct 1 -> Oct 3
    assert stats["totalWallClockSeconds"] == 86400 + 86400 + 2 * 86400
    assert stats["avgWallClockSeconds"] == int(stats["totalWallClockSeconds"] / 3)
    assert [row["tenant"] for row in stats["tenants"]] == ["alpha", "beta"]
    assert stats["tenants"][0]["activeRecords"] == 1
    assert stats["tenants"][1]["totalRecords"] == 1
    assert stats["tenants"][1]["totalWallClockSeconds"] == 2 * 86400


def test_explicit_cpu_memory_does_not_invent_defaults():
    assert _explicit_cpu_memory({"cpu_cores": 2, "memory_gi": 4}) == (2.0, 4.0)
    assert _explicit_cpu_memory({"create_request": {"resourceLimits": {"cpu": "500m"}}}) == (0.5, None)
    assert _explicit_cpu_memory({"create_request": {}}) == (None, None)
    assert _explicit_cpu_memory({}) == (None, None)
