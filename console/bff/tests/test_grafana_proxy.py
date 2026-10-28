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

from app.grafana_proxy import (
    grafana_app_url,
    grafana_proxy_allowed,
    grafana_response_headers,
    rewrite_grafana_location,
    rewrite_grafana_payload,
)

_UPSTREAM = "http://grafana.grafana:3000"
_APP = "https://ops-osb-console.glodon.com/api/grafana/"


def test_allows_dashboard_assets_and_queries():
    assert grafana_proxy_allowed("d/opensandbox-pod-node/711161a", "GET")
    assert grafana_proxy_allowed("public/build/runtime.js", "GET")
    assert grafana_proxy_allowed("api/dashboards/uid/711161a", "GET")
    assert grafana_proxy_allowed("api/annotations", "GET")
    assert grafana_proxy_allowed("api/user/orgs", "GET")
    assert grafana_proxy_allowed("api/ds/query", "POST")
    assert grafana_proxy_allowed("api/frontend-metrics", "POST")
    assert grafana_proxy_allowed(
        "apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/opensandbox-pod-node/dto",
        "GET",
    )
    assert grafana_proxy_allowed("apis/dashboard.grafana.app/", "GET")
    assert grafana_proxy_allowed("api/plugins/grafana-metricsdrilldown-app/settings", "GET")
    assert grafana_proxy_allowed("public/plugins/grafana-lokiexplore-app/module.js", "GET")
    assert grafana_proxy_allowed("api/login/ping", "GET")
    assert grafana_proxy_allowed("api/datasources/uid/prometheus", "GET")
    assert grafana_proxy_allowed(
        "apis/preferences.grafana.app/v1/namespaces/default/preferences/merged",
        "GET",
    )
    assert grafana_proxy_allowed(
        "apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags",
        "POST",
    )


def test_rejects_admin_writes_and_traversal():
    assert not grafana_proxy_allowed("api/admin/users", "GET")
    assert not grafana_proxy_allowed("api/datasources", "POST")
    assert not grafana_proxy_allowed("api/plugins/grafana-lokiexplore-app/install", "POST")
    assert not grafana_proxy_allowed("apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/x", "POST")
    assert not grafana_proxy_allowed("api/users", "GET")
    assert not grafana_proxy_allowed("api/org/users", "GET")
    assert not grafana_proxy_allowed("api/dashboards/uid/711161a", "POST")
    assert not grafana_proxy_allowed("public/../api/admin", "GET")
    assert not grafana_proxy_allowed("login", "GET")


def test_rewrite_html_points_assets_at_console_proxy():
    html = b"""
    <base href="/" />
    <script>
      window.grafanaBootData = {"settings":{"appUrl":"https://grafana-uop.glodon.com/","appSubUrl":""}};
    </script>
    """
    rewritten = rewrite_grafana_payload(
        html,
        "text/html; charset=UTF-8",
        upstream_base=_UPSTREAM,
        app_url=_APP,
    ).decode()
    assert '<base href="/api/grafana/"' in rewritten
    assert '"appSubUrl":"/api/grafana"' in rewritten
    assert '"appUrl":"https://ops-osb-console.glodon.com/api/grafana/"' in rewritten
    assert "grafana-uop.glodon.com" not in rewritten.split("appUrl", 1)[1][:80]


def test_rewrite_html_replaces_incluster_upstream_links():
    html = b'<a href="http://grafana.grafana:3000/d/opensandbox-pod-node/711161a">'
    rewritten = rewrite_grafana_payload(
        html,
        "text/html",
        upstream_base=_UPSTREAM,
        app_url=_APP,
    ).decode()
    assert "http://grafana.grafana:3000" not in rewritten
    assert "https://ops-osb-console.glodon.com/api/grafana/d/opensandbox-pod-node/711161a" in rewritten


def test_rewrite_json_links_and_leaves_javascript_alone():
    body = b'{"url":"http://grafana.grafana:3000/d/abc"}'
    rewritten = rewrite_grafana_payload(
        body,
        "application/json",
        upstream_base=_UPSTREAM,
        app_url=_APP,
    )
    assert rewritten == b'{"url":"https://ops-osb-console.glodon.com/api/grafana/d/abc"}'
    script = b'var x = "http://grafana.grafana:3000/public/build/app.js";'
    assert (
        rewrite_grafana_payload(script, "application/javascript", upstream_base=_UPSTREAM, app_url=_APP)
        == script
    )


def test_location_and_session_cookie_stay_off_the_console_response():
    assert rewrite_grafana_location("/login", _UPSTREAM) == "/api/grafana/login"
    assert (
        rewrite_grafana_location("http://grafana.grafana:3000/d/abc", _UPSTREAM)
        == "/api/grafana/d/abc"
    )
    headers = grafana_response_headers(
        [
            ("Content-Type", "text/html"),
            ("Set-Cookie", "grafana_session=secret"),
            ("Content-Length", "10"),
            ("Location", "/d/abc"),
        ],
        _UPSTREAM,
    )
    assert "set-cookie" not in {k.lower() for k in headers}
    assert "content-length" not in {k.lower() for k in headers}
    assert headers["Location"] == "/api/grafana/d/abc"


def test_app_url_uses_forwarded_https_host():
    url = grafana_app_url(
        {"X-Forwarded-Proto": "https", "Host": "ops-osb-console.glodon.com"},
    )
    assert url == "https://ops-osb-console.glodon.com/api/grafana/"
