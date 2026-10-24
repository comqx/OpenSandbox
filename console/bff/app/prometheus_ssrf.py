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

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_BLOCKED_HOSTNAMES = frozenset(
    {
        "localhost",
        "metadata.google.internal",
        "metadata.google",
    },
)


def _ip_blocked(addr: ipaddress._BaseAddress) -> bool:
    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified,
    )


def validate_prometheus_base_url(raw: str) -> str:
    """Return normalized base URL or raise ValueError."""
    url = raw.strip().rstrip("/")
    if not url:
        raise ValueError("prometheusUrl must be non-empty when set")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("prometheusUrl must use http or https")
    if parsed.username or parsed.password:
        raise ValueError("prometheusUrl must not embed credentials")
    host = parsed.hostname
    if not host:
        raise ValueError("prometheusUrl must include a hostname")
    lowered = host.lower()
    if lowered in _BLOCKED_HOSTNAMES:
        raise ValueError("prometheusUrl hostname is not allowed")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _ip_blocked(literal):
            raise ValueError("prometheusUrl must not target private or link-local addresses")
        return url

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        # In-cluster service names may not resolve from every environment; literal-IP checks still apply.
        return url

    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        resolved = ipaddress.ip_address(sockaddr[0])
        if _ip_blocked(resolved):
            raise ValueError("prometheusUrl must not resolve to private or link-local addresses")

    return url
