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

from app.build_context.service import BuildContextError, _decode_file_body, feature_meta, is_enabled
from app.config import Settings


def _settings(**overrides: object) -> Settings:
    base = {
        "tenants_toml_path": "tenants.toml",
        "bff_session_secret": "x" * 32,
        "bff_admin_token": "token",
        "bff_history_enabled": False,
        "bff_image_build_enabled": True,
        "bff_image_build_oss_endpoint": "https://oss.example.com",
        "bff_image_build_oss_bucket": "bucket",
        "bff_image_build_oss_access_key_id": "id",
        "bff_image_build_oss_access_key_secret": "secret",
    }
    base.update(overrides)
    return Settings(**base)


def test_feature_disabled_without_history_pool():
    settings = _settings()
    assert is_enabled(settings) is False
    meta = feature_meta(settings)
    assert meta["persisted"] is False


def test_decode_utf8_and_base64():
    enc, data = _decode_file_body({"encoding": "utf-8", "content": "hello"})
    assert enc == "utf-8"
    assert data == b"hello"
    enc2, data2 = _decode_file_body({"encoding": "base64", "content": "aGVsbG8="})
    assert enc2 == "base64"
    assert data2 == b"hello"


def test_decode_rejects_invalid_base64():
    with pytest.raises(BuildContextError) as exc:
        _decode_file_body({"encoding": "base64", "content": "not-base64!!!"})
    assert exc.value.code == "INVALID_BASE64"
