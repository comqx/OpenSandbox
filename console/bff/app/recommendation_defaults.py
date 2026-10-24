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

DEFAULT_MEMORY_PROMQL = """max by (pod) (
  container_memory_working_set_bytes{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}
)"""

DEFAULT_CPU_PROMQL = """sum by (pod) (
  rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{pod_regex}}",container!="",container!="POD"}[2m])
)"""
