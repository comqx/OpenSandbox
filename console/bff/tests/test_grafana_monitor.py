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

from app.grafana_monitor import (
    build_embed_urls,
    build_grafana_dashboard_path,
    datasource_query_param,
    resolve_time_range,
)
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
    assert "var-DS_PROM=prometheus" in path


def test_build_grafana_dashboard_path_includes_datasource():
    cfg = {
        "dashboardSlug": "opensandbox-pod-node",
        "dashboardUid": "711161a",
        "refresh": "30s",
        "varNamespace": "var-namespace",
        "varPod": "var-pod",
        "varNode": "var-node",
        "varDatasource": "var-DS_PROM",
        "datasourceUid": "cfzrpakzi1rlsd",
    }
    t0 = datetime(2026, 9, 30, 5, 46, 28, tzinfo=timezone.utc)
    t1 = datetime(2026, 9, 30, 7, 15, 55, tzinfo=timezone.utc)
    path = build_grafana_dashboard_path(
        cfg,
        namespace="opensandbox-system",
        pod_names=[],
        time_from=t0,
        time_to=t1,
    )
    assert "var-DS_PROM=cfzrpakzi1rlsd" in path
    assert "var-namespace=opensandbox-system" in path


def test_datasource_uid_pasted_into_variable_name_still_sets_var_ds_prom():
    name, uid = datasource_query_param(
        {"varDatasource": "cfzrpakzi1rlsd", "datasourceUid": "prometheus"},
    )
    assert (name, uid) == ("var-DS_PROM", "cfzrpakzi1rlsd")


def test_bare_datasource_variable_name_gets_var_prefix():
    name, uid = datasource_query_param(
        {"varDatasource": "DS_PROM", "datasourceUid": "cfzrpakzi1rlsd"},
    )
    assert (name, uid) == ("var-DS_PROM", "cfzrpakzi1rlsd")


def test_proxy_iframe_is_same_origin_path():
    cfg = {
        "baseUrl": "http://grafana.grafana:3000",
        "embedMode": "proxy",
    }
    iframe, external = build_embed_urls(cfg, "/d/opensandbox-pod-node/711161a?kiosk=1")
    assert iframe == "/api/grafana/d/opensandbox-pod-node/711161a?kiosk=1"
    assert external == "http://grafana.grafana:3000/d/opensandbox-pod-node/711161a?kiosk=1"


def test_direct_iframe_uses_grafana_base_url():
    cfg = {
        "baseUrl": "https://grafana.example.com",
        "embedMode": "direct",
    }
    iframe, external = build_embed_urls(cfg, "/d/opensandbox-pod-node/711161a")
    assert iframe == external == "https://grafana.example.com/d/opensandbox-pod-node/711161a"


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
