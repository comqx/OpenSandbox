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

from app.history.store import (
    _aggregate_created_series,
    _aggregate_period_history_stats,
    _explicit_cpu_memory,
    _validate_created_bucket,
)


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


def test_created_series_counts_utc_day_fills_gaps_and_totals():
    period_from = datetime(2026, 10, 1, tzinfo=timezone.utc)
    period_to = datetime(2026, 10, 4, tzinfo=timezone.utc)
    rows = [
        {
            "tenant_name": "beta",
            "created_at": datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc),
        },
        {
            "tenant_name": "alpha",
            "created_at": datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc),
        },
        {
            "tenant_name": "alpha",
            "lifecycle_created_at": datetime(2026, 10, 3, 8, 0, tzinfo=timezone.utc),
        },
        # China morning of Oct 1 is still Sep 30 UTC, outside the window.
        {
            "tenant_name": "alpha",
            "created_at": datetime(2026, 9, 30, 23, 0, tzinfo=timezone.utc),
        },
        # period_to is exclusive.
        {
            "tenant_name": "alpha",
            "created_at": datetime(2026, 10, 4, 0, 0, tzinfo=timezone.utc),
        },
        {"tenant_name": "alpha", "created_at": None},
    ]

    series = _aggregate_created_series(
        rows,
        period_from=period_from,
        period_to=period_to,
        bucket="day",
    )

    assert series["points"] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert series["totals"] == [2, 0, 1]
    assert series["series"] == [
        {"tenant": "alpha", "counts": [1, 0, 1]},
        {"tenant": "beta", "counts": [1, 0, 0]},
    ]


def test_created_series_month_buckets_drop_leading_empty_on_long_span():
    rows = [
        {
            "tenant_name": "gdds",
            "created_at": datetime(2026, 9, 2, tzinfo=timezone.utc),
        },
        {
            "tenant_name": "geip-zpert",
            "created_at": datetime(2026, 10, 19, 2, 0, tzinfo=timezone.utc),
        },
        {
            "tenant_name": "geip-zpert",
            "created_at": datetime(2026, 10, 19, 3, 0, tzinfo=timezone.utc),
        },
    ]

    series = _aggregate_created_series(
        rows,
        period_from=datetime(1970, 1, 1, tzinfo=timezone.utc),
        period_to=datetime(2026, 11, 1, tzinfo=timezone.utc),
        bucket="month",
    )

    assert series["points"][0] == "2026-09"
    assert series["points"][-1] == "2026-10"
    assert series["totals"] == [1, 2]
    assert series["series"][0] == {"tenant": "geip-zpert", "counts": [0, 2]}
    assert series["series"][1] == {"tenant": "gdds", "counts": [1, 0]}


def test_created_day_bucket_rejects_span_over_120_days():
    try:
        _validate_created_bucket(
            "day",
            datetime(2020, 1, 1, tzinfo=timezone.utc),
            datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
    except ValueError as exc:
        assert "120" in str(exc)
    else:
        raise AssertionError("expected ValueError")
    assert (
        _validate_created_bucket(
            "month",
            datetime(1970, 1, 1, tzinfo=timezone.utc),
            datetime(2026, 11, 1, tzinfo=timezone.utc),
        )
        == "month"
    )


def test_explicit_cpu_memory_does_not_invent_defaults():
    assert _explicit_cpu_memory({"cpu_cores": 2, "memory_gi": 4}) == (2.0, 4.0)
    assert _explicit_cpu_memory({"create_request": {"resourceLimits": {"cpu": "500m"}}}) == (0.5, None)
    assert _explicit_cpu_memory({"create_request": {}}) == (None, None)
    assert _explicit_cpu_memory({}) == (None, None)
