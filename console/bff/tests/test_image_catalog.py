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

from app.config import Settings
from app.image_catalog import (
    ImageCatalogError,
    create_image,
    delete_image,
    init_image_catalog,
    list_images,
    update_image,
)


def _settings(path: str) -> Settings:
    return Settings(
        tenants_toml_path="tenants.toml",
        bff_session_secret="x" * 32,
        bff_admin_token="token",
        bff_history_enabled=False,
        bff_image_catalog_path=path,
    )


def test_file_catalog_roundtrip(tmp_path):
    path = tmp_path / "catalog.json"
    init_image_catalog(_settings(str(path)))

    created = create_image(
        {
            "displayName": "Python 3.12",
            "imageUri": "hub.example.com/python:3.12",
            "scenarios": "数据分析, Agent",
            "systemPackages": ["git", "git", " curl "],
            "runtimePackages": ["Python 3.12"],
        },
        "gcbp",
    )
    assert created["maintainer"] == "gcbp"
    assert created["createdBy"] == "gcbp"
    assert created["scenarios"] == ["数据分析", "Agent"]
    assert created["systemPackages"] == ["git", "curl"]

    listed = list_images()
    assert listed["persisted"] is True
    assert listed["source"] == "file"
    assert [item["id"] for item in listed["items"]] == [created["id"]]

    with pytest.raises(ImageCatalogError) as duplicate:
        create_image(
            {"displayName": "dup", "imageUri": "hub.example.com/python:3.12"},
            "gcbp",
        )
    assert duplicate.value.status_code == 409

    updated = update_image(created["id"], {"displayName": "Python"}, "admin")
    assert updated["displayName"] == "Python"
    assert updated["imageUri"] == "hub.example.com/python:3.12"
    assert updated["updatedBy"] == "admin"
    assert updated["scenarios"] == ["数据分析", "Agent"]

    init_image_catalog(_settings(str(path)))
    reloaded = list_images()["items"]
    assert reloaded[0]["displayName"] == "Python"

    delete_image(created["id"])
    assert list_images()["items"] == []
    assert path.is_file()


def test_rejects_image_uri_with_whitespace(tmp_path):
    init_image_catalog(_settings(str(tmp_path / "catalog.json")))
    with pytest.raises(ImageCatalogError) as exc:
        create_image({"displayName": "x", "imageUri": "bad image"}, "gcbp")
    assert exc.value.status_code == 400


def test_readonly_without_store():
    init_image_catalog(_settings(""))
    assert list_images() == {"persisted": False, "source": "none", "items": []}
    with pytest.raises(ImageCatalogError) as exc:
        create_image({"displayName": "x", "imageUri": "python:3.12"}, "gcbp")
    assert exc.value.status_code == 503
