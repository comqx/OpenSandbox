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

import hashlib
from typing import Any
from urllib.parse import quote

from app.config import Settings


def oss_settings(settings: Settings) -> tuple[str, str, str, str, str] | None:
    endpoint = settings.bff_image_build_oss_endpoint.strip() or settings.bff_nodeagent_oss_endpoint.strip()
    bucket = settings.bff_image_build_oss_bucket.strip() or settings.bff_nodeagent_oss_bucket.strip()
    key_id = settings.bff_image_build_oss_access_key_id.strip() or settings.bff_nodeagent_oss_access_key_id.strip()
    key_secret = (
        settings.bff_image_build_oss_access_key_secret.strip()
        or settings.bff_nodeagent_oss_access_key_secret.strip()
    )
    prefix = settings.bff_image_build_oss_key_prefix.strip() or "console/image-build"
    if not (endpoint and bucket and key_id and key_secret):
        return None
    return endpoint, bucket, key_id, key_secret, prefix.strip("/")


def file_object_key(
    prefix: str,
    tenant_id: str,
    context_id: str,
    relative_path: str,
    sha256_hex: str,
) -> str:
    shard = sha256_hex[:8]
    safe_path = quote(relative_path, safe="/")
    return f"{prefix}/v1/tenant/{tenant_id}/context/{context_id}/files/{shard}/{safe_path}"


def tar_object_key(prefix: str, tenant_id: str, context_id: str) -> str:
    return f"{prefix}/v1/tenant/{tenant_id}/context/{context_id}/context.tar.gz"


class BuildContextOss:
    def __init__(self, settings: Settings) -> None:
        resolved = oss_settings(settings)
        if resolved is None:
            raise RuntimeError("OSS is not configured for image build")
        endpoint, bucket, key_id, key_secret, prefix = resolved
        import oss2

        auth = oss2.Auth(key_id, key_secret)
        self._bucket = oss2.Bucket(auth, endpoint, bucket)
        self._prefix = prefix

    def put_bytes(self, key: str, data: bytes, *, content_type: str, sha256_hex: str, tenant_id: str) -> None:
        headers = {
            "Content-Type": content_type,
            "x-oss-meta-sha256": sha256_hex,
            "x-oss-meta-tenant-id": tenant_id,
        }
        self._bucket.put_object(key, data, headers=headers)

    def get_bytes(self, key: str) -> bytes:
        result = self._bucket.get_object(key)
        return result.read()

    def delete_object(self, key: str) -> None:
        self._bucket.delete_object(key)

    def sign_get_url(self, key: str, expires_seconds: int = 900) -> str:
        return self._bucket.sign_url("GET", key, expires_seconds)

    @property
    def prefix(self) -> str:
        return self._prefix


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
