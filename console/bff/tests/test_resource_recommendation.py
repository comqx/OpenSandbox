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

from datetime import datetime, timedelta, timezone

import pytest

from app.history.store import _overlap_seconds_in_period, effective_lifecycle_interval
from app.platform_settings import apply_recommendation_save, merge_resource_recommendation
from app.recommendation_defaults import (
    DEFAULT_CPU_PEAK_PROMQL,
    DEFAULT_CPU_PROMQL,
    DEFAULT_MEMORY_PROMQL,
    LEGACY_CPU_PROMQL,
    LEGACY_MEMORY_PROMQL,
    LEGACY_POD_CPU_PROMQL,
    LEGACY_POD_MEMORY_PROMQL,
)
from app.resource_recommendation import (
    RecommendationError,
    aggregate_sandbox_recommendations,
    build_requests_limits,
    classify_sandbox_metrics,
    format_cpu_cores,
    format_memory_bytes,
    iter_prom_range_chunks,
    parse_cpu_cores,
    parse_memory_bytes,
    percentile,
    recommendation_pod_names,
    sandbox_usage_summary,
    substitute_promql,
    window_to_period,
)


def test_substitute_promql():
    q = 'metric{namespace="{{namespace}}",pod="{{pod}}"}'
    assert substitute_promql(q, namespace="tenant-a", pod="sbx-1-0") == 'metric{namespace="tenant-a",pod="sbx-1-0"}'


def test_substitute_promql_pod_regex_multi():
    q = 'metric{namespace="{{namespace}}",pod=~"{{pod_regex}}"}'
    out = substitute_promql(q, namespace="tenant-a", pods=["a-0", "b-0"])
    assert out == 'metric{namespace="tenant-a",pod=~"a-0|b-0"}'


def test_substitute_promql_legacy_template_batch():
    q = 'metric{namespace="{{namespace}}",pod="{{pod}}"}'
    out = substitute_promql(q, namespace="tenant-a", pods=["a-0", "b-0"])
    assert out == 'metric{namespace="tenant-a",pod=~"a-0|b-0"}'


def test_substitute_promql_escapes_quotes():
    q = 'metric{namespace="{{namespace}}",pod="{{pod}}"}'
    with pytest.raises(RecommendationError):
        substitute_promql(q, namespace='bad"ns', pod="sbx-1-0")


def test_percentile():
    assert percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5
    assert percentile([10.0], 95) == 10.0


def test_format_cpu_and_memory():
    assert format_cpu_cores(0.04) == "40m"
    assert format_cpu_cores(1.0) == "1"
    assert format_memory_bytes(100 * 1024**2) == "128Mi"
    assert format_memory_bytes(70 * 1024**2) == "96Mi"
    assert parse_cpu_cores("100m") == 0.1
    assert parse_memory_bytes("200Mi") == 200 * 1024**2
    assert parse_memory_bytes("100M") == 100 * 1000**2
    assert parse_memory_bytes("100m") == 0.1
    with pytest.raises(ValueError):
        parse_memory_bytes("100mi")


def test_build_requests_limits_keeps_floor_string_and_quantizes_above_it():
    out = build_requests_limits(
        cpu_request_cores=0.02,
        memory_request_bytes=100 * 1024**2,
        cpu_limit_base_cores=0.02,
        memory_limit_base_bytes=100 * 1024**2,
        percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
    )
    assert out["requests"]["cpu"] == "50m"
    assert out["limits"]["cpu"] == "150m"
    assert out["requests"]["memory"] == "128Mi"
    assert out["limits"]["memory"] == "200Mi"

    raised = build_requests_limits(
        cpu_request_cores=0.2,
        memory_request_bytes=64 * 1024**2,
        cpu_limit_base_cores=0.05,
        memory_limit_base_bytes=64 * 1024**2,
        percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
    )
    assert raised["requests"]["cpu"] == "200m"
    assert raised["limits"]["cpu"] == "200m"

    higher_floor = build_requests_limits(
        cpu_request_cores=0.02,
        memory_request_bytes=64 * 1024**2,
        cpu_limit_base_cores=0.02,
        memory_limit_base_bytes=64 * 1024**2,
        percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="200m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
    )
    assert higher_floor["requests"]["cpu"] == "50m"
    assert higher_floor["limits"]["cpu"] == "200m"


def test_window_to_period():
    start, end = window_to_period("7d")
    assert end > start


def _summary(
    sandbox_id: str,
    *,
    cpu_request: float,
    memory_request: float,
    cpu_peak: float,
    memory_peak: float,
    samples: int = 10,
    peak_fallback: bool = False,
) -> dict:
    return {
        "sandboxId": sandbox_id,
        "cpuSampleCount": samples,
        "memorySampleCount": samples,
        "cpuRequestCores": cpu_request,
        "memoryRequestBytes": memory_request,
        "cpuPeakCores": cpu_peak,
        "memoryPeakBytes": memory_peak,
        "cpuPeakFallback": peak_fallback,
    }


def test_sandbox_usage_summary_uses_within_sandbox_percentiles_and_peaks():
    summary = sandbox_usage_summary(
        [0.0, 0.0, 0.0, 1.0],
        [1.0, 2.0, 3.0, 4.0],
        [0.2, 2.0],
    )
    assert summary["cpuRequestCores"] == pytest.approx(0.25)
    assert summary["memoryRequestBytes"] == pytest.approx(3.85)
    assert summary["cpuPeakCores"] == 2.0
    assert summary["memoryPeakBytes"] == 4.0
    assert summary["cpuPeakFallback"] is False


def test_sandbox_usage_summary_falls_back_when_peak_series_is_empty():
    summary = sandbox_usage_summary([0.1, 0.4, 0.2], [8.0, 9.0, 10.0], [])
    assert summary["cpuPeakCores"] == 0.4
    assert summary["cpuPeakFallback"] is True


def test_equal_sandbox_weight_ignores_long_idle_lifetime():
    idle = _summary("idle", cpu_request=0.01, memory_request=64 * 1024**2, cpu_peak=0.02, memory_peak=64 * 1024**2)
    busy = [
        _summary(
            f"busy-{i:03d}",
            cpu_request=1.0,
            memory_request=1024**3,
            cpu_peak=1.5,
            memory_peak=2 * 1024**3,
        )
        for i in range(100)
    ]
    out = aggregate_sandbox_recommendations(
        [idle, *busy],
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert out["aggregation"] == "per_sandbox_percentile"
    assert out["confidence"] == "ok"
    assert out["requests"]["cpu"] == "1"
    assert out["requests"]["memory"] == "1Gi"
    assert out["limits"]["cpu"] == "1800m"
    assert out["limits"]["memory"] == "2368Mi"
    assert out["distribution"]["sandboxCountQualified"] == 101


def test_cpu_request_stays_on_p75_when_configured_percentile_is_95():
    rows = [
        _summary(
            f"s-{i:02d}",
            cpu_request=0.1 * (i + 1),
            memory_request=256 * 1024**2,
            cpu_peak=0.2,
            memory_peak=256 * 1024**2,
        )
        for i in range(20)
    ]
    out = aggregate_sandbox_recommendations(
        rows,
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert out["requests"]["cpu"] == "1530m"
    assert out["cpuBaseCores"] == pytest.approx(1.525)


def test_cpu_and_memory_cohort_percentiles_apply_separately():
    rows = [
        _summary(
            f"s-{i}",
            cpu_request=0.1 * (i + 1),
            memory_request=(i + 1) * 100 * 1024**2,
            cpu_peak=0.1 * (i + 1),
            memory_peak=(i + 1) * 200 * 1024**2,
        )
        for i in range(5)
    ]
    out = aggregate_sandbox_recommendations(
        rows,
        cohort_percentile=95,
        cpu_cohort_percentile=100,
        memory_cohort_percentile=50,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert out["requests"]["cpu"] == "400m"
    assert out["limits"]["cpu"] == "600m"
    assert out["requests"]["memory"] == "320Mi"
    assert out["limits"]["memory"] == "704Mi"
    assert out["cpuPercentile"] == 100
    assert out["memoryPercentile"] == 50


def test_legacy_percentile_fills_cpu_and_memory_percentiles():
    merged, reset = merge_resource_recommendation({"schemaVersion": 2, "percentile": 90})
    assert merged["cpuPercentile"] == 90
    assert merged["memoryPercentile"] == 90
    assert reset is False

    split, split_reset = merge_resource_recommendation(
        {"schemaVersion": 2, "percentile": 90, "cpuPercentile": 80, "memoryPercentile": 99}
    )
    assert split["cpuPercentile"] == 80
    assert split["memoryPercentile"] == 99
    assert split_reset is False


def test_heterogeneous_memory_peaks_warn_without_blocking_result():
    small = [
        _summary(f"s-{i:02d}", cpu_request=0.2, memory_request=100 * 1024**2, cpu_peak=0.4, memory_peak=100 * 1024**2)
        for i in range(19)
    ]
    huge = _summary("huge", cpu_request=0.2, memory_request=100 * 1024**2, cpu_peak=0.4, memory_peak=10000 * 1024**2)
    out = aggregate_sandbox_recommendations(
        [*small, huge],
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert "heterogeneous_cohort" in out["warnings"]
    assert out["requests"]["cpu"] == "200m"


def test_cohort_below_20_is_low_confidence_and_below_5_is_rejected():
    five = [
        _summary(f"s-{i}", cpu_request=0.5, memory_request=256 * 1024**2, cpu_peak=1.0, memory_peak=512 * 1024**2)
        for i in range(5)
    ]
    low = aggregate_sandbox_recommendations(
        five,
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert low["confidence"] == "low"
    with pytest.raises(RecommendationError) as exc:
        aggregate_sandbox_recommendations(
            five[:4],
            cohort_percentile=95,
            cpu_limit_ratio=1.2,
            cpu_limit_floor="100m",
            memory_limit_ratio=1.15,
            memory_limit_floor="200Mi",
            single_sandbox_filter=False,
            schema_version=2,
        )
    assert exc.value.code == "INSUFFICIENT_DATA"


def test_single_sandbox_filter_allows_one_qualified_sandbox():
    out = aggregate_sandbox_recommendations(
        [_summary("only", cpu_request=0.5, memory_request=256 * 1024**2, cpu_peak=1.0, memory_peak=512 * 1024**2)],
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=True,
        schema_version=2,
        extra_warnings=["headroom_defaults_applied"],
    )
    assert out["confidence"] == "low"
    assert out["requests"]["cpu"] == "500m"
    assert out["warnings"] == ["headroom_defaults_applied"]
    assert out["schemaVersion"] == 2


def test_cpu_peak_fallback_is_reported():
    rows = [
        _summary(
            f"s-{i}",
            cpu_request=0.2,
            memory_request=256 * 1024**2,
            cpu_peak=0.4,
            memory_peak=512 * 1024**2,
            peak_fallback=True,
        )
        for i in range(5)
    ]
    out = aggregate_sandbox_recommendations(
        rows,
        cohort_percentile=95,
        cpu_limit_ratio=1.2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.15,
        memory_limit_floor="200Mi",
        single_sandbox_filter=False,
        schema_version=2,
    )
    assert "cpu_peak_fallback" in out["warnings"]


def test_recommendation_pod_names_include_legacy_batchsandbox():
    assert recommendation_pod_names("abc") == ["abc-0", "sandbox-abc-0"]


def test_prom_range_chunks_cover_15_days_without_passing_11000_points():
    start = datetime(2026, 10, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=15)
    chunks = list(iter_prom_range_chunks(start, end))
    assert chunks[0] == (start, start + timedelta(days=7))
    assert chunks[-1][1] == end
    assert len(chunks) == 3
    for chunk_start, chunk_end in chunks:
        assert (chunk_end - chunk_start).total_seconds() / 60 <= 11000
    assert list(iter_prom_range_chunks(start, start + timedelta(days=7))) == [(start, start + timedelta(days=7))]


def test_default_promql_targets_sandbox_container():
    assert 'container="sandbox"' in DEFAULT_CPU_PROMQL
    assert "[2m]" in DEFAULT_CPU_PROMQL
    assert 'container="sandbox"' in DEFAULT_CPU_PEAK_PROMQL
    assert "[1m]" in DEFAULT_CPU_PEAK_PROMQL
    assert 'container="sandbox"' in DEFAULT_MEMORY_PROMQL
    assert "sum by (pod)" in DEFAULT_MEMORY_PROMQL


def test_legacy_saved_promql_migrates_to_sandbox_container_defaults():
    merged, headroom_reset = merge_resource_recommendation(
        {
            "memoryPromql": LEGACY_MEMORY_PROMQL,
            "cpuPromql": LEGACY_CPU_PROMQL,
            "cpuLimitRatio": 2.0,
            "memoryLimitRatio": 1.5,
            "percentile": 90,
        }
    )
    assert merged["memoryPromql"] == DEFAULT_MEMORY_PROMQL
    assert merged["cpuPromql"] == DEFAULT_CPU_PROMQL
    assert merged["cpuPeakPromql"] == DEFAULT_CPU_PEAK_PROMQL
    assert merged["cpuLimitRatio"] == 1.2
    assert merged["memoryLimitRatio"] == 1.15
    assert merged["percentile"] == 90
    assert merged["schemaVersion"] == 1
    assert headroom_reset is True

    saved, reset_again = merge_resource_recommendation(
        {"cpuLimitRatio": 1.4, "memoryLimitRatio": 1.3, "schemaVersion": 2, "percentile": 90}
    )
    assert saved["cpuLimitRatio"] == 1.4
    assert saved["memoryLimitRatio"] == 1.3
    assert saved["schemaVersion"] == 2
    assert reset_again is False


def test_older_pod_placeholder_promql_migrates_despite_whitespace():
    merged, headroom_reset = merge_resource_recommendation(
        {
            "memoryPromql": "\n" + LEGACY_POD_MEMORY_PROMQL + "\n",
            "cpuPromql": LEGACY_POD_CPU_PROMQL,
            "prometheusUrl": "http://prom.example",
        }
    )
    assert merged["memoryPromql"] == DEFAULT_MEMORY_PROMQL
    assert merged["cpuPromql"] == DEFAULT_CPU_PROMQL
    assert merged["cpuLimitRatio"] == 1.2
    assert merged["memoryLimitRatio"] == 1.15
    assert headroom_reset is True


def test_pre_v2_save_drops_old_ratios_and_legacy_promql():
    saved = apply_recommendation_save(
        {
            "cpuLimitRatio": 2.0,
            "memoryLimitRatio": 1.5,
            "cpuPromql": LEGACY_POD_CPU_PROMQL,
            "memoryPromql": LEGACY_MEMORY_PROMQL,
        },
        {
            "cpuLimitRatio": 2.0,
            "memoryLimitRatio": 1.5,
            "cpuPromql": LEGACY_POD_CPU_PROMQL,
            "memoryPromql": LEGACY_MEMORY_PROMQL,
            "percentile": 90,
        },
    )
    assert saved["schemaVersion"] == 2
    assert saved["cpuLimitRatio"] == 1.2
    assert saved["memoryLimitRatio"] == 1.15
    assert saved["cpuPromql"] == DEFAULT_CPU_PROMQL
    assert saved["memoryPromql"] == DEFAULT_MEMORY_PROMQL
    assert saved["cpuPeakPromql"] == DEFAULT_CPU_PEAK_PROMQL
    assert saved["percentile"] == 90


def test_v2_save_keeps_explicit_headroom():
    saved = apply_recommendation_save(
        {"schemaVersion": 2, "cpuLimitRatio": 1.4, "memoryLimitRatio": 1.3},
        {"cpuLimitRatio": 1.5, "memoryLimitRatio": 1.25},
    )
    assert saved["schemaVersion"] == 2
    assert saved["cpuLimitRatio"] == 1.5
    assert saved["memoryLimitRatio"] == 1.25


def test_running_interval_stops_at_expires_at():
    start = datetime(2026, 10, 20, tzinfo=timezone.utc)
    expires = start + timedelta(minutes=10)
    now = datetime(2026, 10, 27, tzinfo=timezone.utc)
    row = {
        "lifecycle_created_at": start,
        "expires_at": expires,
        "state": "Running",
        "ended_at": None,
        "deleted_at": None,
    }
    assert effective_lifecycle_interval(row, period_from=start, period_to=now, now=now) == (start, expires)

    future = dict(row, expires_at=datetime(2026, 10, 30, tzinfo=timezone.utc))
    assert effective_lifecycle_interval(future, period_from=start, period_to=now, now=now) == (start, now)

    overlap = _overlap_seconds_in_period(row, period_from=start, period_to=now, now=now)
    assert overlap == (now - start).total_seconds()


def test_classify_sandbox_metrics_picks_primary_then_legacy_and_names_gaps():
    start = datetime(2026, 10, 20, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    inside = [(start.timestamp() + 60 * i, 1.0) for i in range(3)]
    outside = [(start.timestamp() - 3600, 1.0)]

    legacy = classify_sandbox_metrics(
        ["abc-0", "sandbox-abc-0"],
        {"sandbox-abc-0": inside},
        {"sandbox-abc-0": inside},
        {"sandbox-abc-0": inside},
        start,
        end,
    )
    assert legacy["pod"] == "sandbox-abc-0"
    assert legacy["cpuPeakFallback"] is False

    primary = classify_sandbox_metrics(
        ["abc-0", "sandbox-abc-0"],
        {"abc-0": inside, "sandbox-abc-0": [(start.timestamp(), 9.0)]},
        {"abc-0": inside, "sandbox-abc-0": [(start.timestamp(), 9.0)]},
        {"abc-0": inside},
        start,
        end,
    )
    assert primary["pod"] == "abc-0"

    unresolved = classify_sandbox_metrics(["abc-0", "sandbox-abc-0"], {}, {}, {}, start, end)
    assert unresolved == {"excluded": "pod_name_unresolved"}

    clipped = classify_sandbox_metrics(
        ["abc-0", "sandbox-abc-0"],
        {"abc-0": outside},
        {"abc-0": outside},
        {},
        start,
        end,
    )
    assert clipped == {"excluded": "no_metrics_in_window"}

    partial = classify_sandbox_metrics(
        ["abc-0"],
        {"abc-0": inside},
        {},
        {},
        start,
        end,
    )
    assert partial == {"excluded": "partial_metrics"}
