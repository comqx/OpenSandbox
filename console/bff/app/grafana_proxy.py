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

"""Same-origin Grafana reverse proxy helpers.

Grafana stays mounted at its own public root. HTML that passes through the
console is rewritten so the browser loads assets and queries under /api/grafana.
"""

from __future__ import annotations

import re

PROXY_PREFIX = "/api/grafana"

# Dashboard page, static assets, and the read APIs the embedded UI calls.
# Grafana 11+ loads the dashboard from apis/dashboard.grafana.app, not only /api/dashboards.
_GET_PREFIXES = (
    "d/",
    "public/",
    "avatar/",
    "api/ds/",
    "api/dashboards/",
    "api/annotations/",
    "api/frontend-metrics",
    "api/plugins",
    "api/datasources",
    "api/login/ping",
    "apis/dashboard.grafana.app",
    "apis/folder.grafana.app",
    "apis/folderalpha.grafana.app",
    "apis/preferences.grafana.app",
    "apis/features.grafana.app",
)
_GET_EXACT = frozenset(
    {
        "api/annotations",
        "api/frontend-metrics",
        "api/user",
        "api/user/orgs",
        "api/user/teams",
        "api/user/preferences",
        "api/org",
        "api/org/preferences",
    }
)
# Queries, the metrics beacon, and OpenFeature flag evaluation during boot.
# Writes to dashboards, users, and datasources stay on the public Grafana host.
_POST_PREFIXES = (
    "api/ds/",
    "api/frontend-metrics",
    "apis/features.grafana.app/",
)

_BASE_HREF = re.compile(
    r'(<base\b[^>]*?\bhref\s*=\s*)(["\'])([^"\']*)(\2)',
    re.IGNORECASE,
)
_APP_SUB_URL = re.compile(r'(["\']appSubUrl["\']\s*:\s*["\'])([^"\']*)(["\'])')
_APP_URL = re.compile(r'(["\']appUrl["\']\s*:\s*["\'])([^"\']*)(["\'])')

_DROPPED_RESPONSE_HEADERS = frozenset(
    {
        "transfer-encoding",
        "connection",
        "content-encoding",
        "content-length",
        "set-cookie",
    }
)


def grafana_proxy_allowed(path: str, method: str) -> bool:
    """Return whether this upstream path may be proxied for an embedded dashboard."""
    verb = method.upper()
    if verb not in {"GET", "HEAD", "POST"}:
        return False
    normalized = path.strip("/")
    if not normalized or "\\" in normalized:
        return False
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return False
    if verb == "POST":
        return _matches(normalized, _POST_PREFIXES)
    return normalized in _GET_EXACT or _matches(normalized, _GET_PREFIXES)


def grafana_app_url(headers: dict[str, str]) -> str:
    """Absolute console URL for Grafana boot data, or the path when the host is unknown."""
    lowered = {k.lower(): v for k, v in headers.items()}
    proto = lowered.get("x-forwarded-proto", "").split(",")[0].strip()
    host = (lowered.get("x-forwarded-host") or lowered.get("host") or "").split(",")[0].strip()
    if proto in {"http", "https"} and host:
        return f"{proto}://{host}{PROXY_PREFIX}/"
    return f"{PROXY_PREFIX}/"


def rewrite_grafana_payload(
    content: bytes,
    content_type: str | None,
    *,
    upstream_base: str,
    app_url: str,
) -> bytes:
    """Point embedded Grafana HTML (and JSON links) at the console proxy prefix."""
    ctype = (content_type or "").split(";")[0].strip().lower()
    upstream = upstream_base.rstrip("/")
    app = app_url if app_url.endswith("/") else f"{app_url}/"
    if ctype == "text/html":
        text = content.decode("utf-8", errors="replace")
        if upstream:
            text = text.replace(f"{upstream}/", app)
            text = text.replace(upstream, app.rstrip("/"))
        text = _BASE_HREF.sub(rf"\1\2{PROXY_PREFIX}/\4", text)
        text = _APP_SUB_URL.sub(rf"\1{PROXY_PREFIX}\3", text)
        text = _APP_URL.sub(rf"\1{app}\3", text)
        return text.encode("utf-8")
    if ctype == "application/json" and upstream:
        text = content.decode("utf-8", errors="replace")
        text = text.replace(f"{upstream}/", app).replace(upstream, app.rstrip("/"))
        return text.encode("utf-8")
    return content


def rewrite_grafana_location(location: str, upstream_base: str) -> str:
    """Keep redirects inside the console proxy. Grafana's public host is left unchanged."""
    value = location.strip()
    upstream = upstream_base.rstrip("/")
    if upstream and value.startswith(upstream):
        value = value[len(upstream) :] or "/"
    if value.startswith("/") and not (value == PROXY_PREFIX or value.startswith(f"{PROXY_PREFIX}/")):
        return f"{PROXY_PREFIX}{value}"
    return location


def grafana_response_headers(headers: list[tuple[str, str]], upstream_base: str) -> dict[str, str]:
    """Drop hop-by-hop and session headers. Rewrite relative redirects onto the proxy."""
    filtered: dict[str, str] = {}
    for key, value in headers:
        if key.lower() in _DROPPED_RESPONSE_HEADERS:
            continue
        if key.lower() == "location":
            value = rewrite_grafana_location(value, upstream_base)
        filtered[key] = value
    return filtered


def _matches(path: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        if prefix.endswith("/"):
            if path.startswith(prefix):
                return True
            continue
        if path == prefix or path.startswith(f"{prefix}/"):
            return True
    return False
