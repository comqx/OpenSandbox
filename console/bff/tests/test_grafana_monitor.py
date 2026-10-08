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

from app.grafana_monitor import build_grafana_dashboard_path, resolve_time_range
from app.k8s_resources import primary_pod_name_for_sandbox


def test_build_grafana_dashboard_path_with_pod():
    cfg = {
        "dashboardSlug": "opensandbox-pod-node",
        "dashboardUid": "711161a",
        "refresh": "30s",
        "varNamespace": "var-namespace",
        "varPod": "var-pod",
        "varNode": "var-node",
    }
    t0 = datetime(2026, 9, 30, 5, 46, 28, tzinfo=timezone.utc)
    t1 = datetime(2026, 9, 30, 7, 15, 55, tzinfo=timezone.utc)
    path = build_grafana_dashboard_path(
        cfg,
        namespace="cidas",
        pod_names=["sandbox-pod-abc"],
        time_from=t0,
        time_to=t1,
    )
    assert path.startswith("/d/opensandbox-pod-node/711161a?")
    assert "var-namespace=cidas" in path
    assert "var-pod=sandbox-pod-abc" in path
    # Grafana parses from/to as epoch ms; ISO strings (especially with sub-ms) are often ignored.
    assert "from=1790747188000" in path
    assert "to=1790752555000" in path
    assert "timezone=Asia%2FShanghai" in path
    assert "kiosk=1" in path
    assert "_dash.hideLinks=true" in path
    assert "hideLogo=1" in path
    assert "expandRows=true" in path


def test_primary_pod_name_for_sandbox():
    assert primary_pod_name_for_sandbox("abc123") == "abc123-0"
    assert primary_pod_name_for_sandbox("abc123-0") == "abc123-0"


def test_resolve_time_range_uses_history_when_no_sandbox():
    history = {
        "createdAt": "2026-09-30T05:00:00Z",
        "endedAt": "2026-09-30T06:00:00Z",
        "state": "Terminated",
    }
    start, end, _ = resolve_time_range(sandbox=None, history=history)
    assert start.isoformat().startswith("2026-09-30T05:00:00")
    assert end.isoformat().startswith("2026-09-30T06:00:00")
