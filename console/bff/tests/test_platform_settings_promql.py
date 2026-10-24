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
from unittest.mock import MagicMock

from app.platform_settings import _validate_resource_recommendation_patch

MEMORY = """max by (pod) (
  container_memory_working_set_bytes{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}
)"""

CPU = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}[2m])
)"""


def test_validate_promql_with_pod_regex():
    patch = _validate_resource_recommendation_patch(
        {"memoryPromql": MEMORY, "cpuPromql": CPU},
        MagicMock(),
    )
    assert "{{pod_regex}}" in patch["memoryPromql"]


def test_validate_promql_normalizes_single_brace_namespace():
    mem = MEMORY.replace("{{namespace}}", "{namespace}")
    patch = _validate_resource_recommendation_patch(
        {"memoryPromql": mem, "cpuPromql": CPU},
        MagicMock(),
    )
    assert "{{namespace}}" in patch["memoryPromql"]


def test_validate_promql_rejects_missing_pod_placeholder():
    bad = MEMORY.replace('pod=~"{{pod_regex}}"', 'pod="sandbox-0"')
    with pytest.raises(ValueError, match="pod_regex"):
        _validate_resource_recommendation_patch({"memoryPromql": bad}, MagicMock())
