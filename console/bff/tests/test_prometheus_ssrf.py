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

from app.prometheus_ssrf import validate_prometheus_base_url


def test_validate_prometheus_base_url_accepts_public_https():
    assert validate_prometheus_base_url("https://prometheus.example.com/") == "https://prometheus.example.com"


def test_validate_prometheus_base_url_allows_private_ip_when_internal_enabled():
    assert (
        validate_prometheus_base_url("http://10.96.0.1:9090", allow_internal=True)
        == "http://10.96.0.1:9090"
    )


def test_validate_prometheus_base_url_rejects_private_ip_when_internal_disabled():
    with pytest.raises(ValueError, match="private"):
        validate_prometheus_base_url("http://10.0.0.1:9090", allow_internal=False)


def test_validate_prometheus_base_url_rejects_localhost():
    with pytest.raises(ValueError, match="loopback|not allowed"):
        validate_prometheus_base_url("http://localhost:9090")


def test_validate_prometheus_base_url_rejects_file_scheme():
    with pytest.raises(ValueError, match="http or https"):
        validate_prometheus_base_url("file:///etc/passwd")
