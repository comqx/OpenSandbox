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

DEFAULT_MEMORY_PROMQL = """sum by (pod) (
  container_memory_working_set_bytes{namespace="{{namespace}}",pod=~"{{pod_regex}}",container="sandbox"}
)"""

DEFAULT_CPU_PROMQL = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{pod_regex}}",container="sandbox"}[2m])
)"""

DEFAULT_CPU_PEAK_PROMQL = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{pod_regex}}",container="sandbox"}[1m])
)"""

# Saved settings that still contain a previous pod-wide default are rewritten
# to the sandbox-container queries above. Custom templates are left untouched.
LEGACY_MEMORY_PROMQL = """max by (pod) (
  container_memory_working_set_bytes{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}
)"""

LEGACY_CPU_PROMQL = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}[2m])
)"""

LEGACY_POD_MEMORY_PROMQL = """max by (pod) (
  container_memory_working_set_bytes{namespace="{{namespace}}",pod="{{pod}}",container!="",container!="POD"}
)"""

LEGACY_POD_CPU_PROMQL = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod="{{pod}}",container!="",container!="POD"}[2m])
)"""


def _promql_compare_key(value: str) -> str:
    return "\n".join(line.strip() for line in value.strip().splitlines() if line.strip())


_LEGACY_MEMORY_KEYS = {
    _promql_compare_key(item) for item in (LEGACY_MEMORY_PROMQL, LEGACY_POD_MEMORY_PROMQL)
}
_LEGACY_CPU_KEYS = {
    _promql_compare_key(item) for item in (LEGACY_CPU_PROMQL, LEGACY_POD_CPU_PROMQL)
}


def canonicalize_recommendation_promql(key: str, value: str) -> str:
    """Replace a known historical default query. Any other template is kept."""
    normalized = _promql_compare_key(value)
    if key == "memoryPromql" and normalized in _LEGACY_MEMORY_KEYS:
        return DEFAULT_MEMORY_PROMQL
    if key == "cpuPromql" and normalized in _LEGACY_CPU_KEYS:
        return DEFAULT_CPU_PROMQL
    return value.strip()
