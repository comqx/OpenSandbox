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

import pytest

from app.resource_recommendation import (
    RecommendationError,
    build_requests_limits,
    format_cpu_cores,
    format_memory_bytes,
    parse_cpu_cores,
    parse_memory_bytes,
    percentile,
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
    assert format_cpu_cores(0.04) == "50m"
    assert format_cpu_cores(1.0) == "1"
    assert format_memory_bytes(100 * 1024**2) == "128Mi"
    assert parse_cpu_cores("100m") == 0.1
    assert parse_memory_bytes("200Mi") == 200 * 1024**2


def test_build_requests_limits_applies_floors_and_ratios():
    out = build_requests_limits(
        cpu_base_cores=0.02,
        memory_base_bytes=100 * 1024**2,
        percentile=95,
        cpu_limit_ratio=2,
        cpu_limit_floor="100m",
        memory_limit_ratio=1.5,
        memory_limit_floor="200Mi",
    )
    assert out["requests"]["cpu"] == "50m"
    assert out["limits"]["cpu"] == "100m"
    assert parse_memory_bytes(out["limits"]["memory"]) >= parse_memory_bytes("200Mi")
    assert parse_memory_bytes(out["requests"]["memory"]) <= parse_memory_bytes(out["limits"]["memory"])


def test_window_to_period():
    start, end = window_to_period("7d")
    assert end > start
