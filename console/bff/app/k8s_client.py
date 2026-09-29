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

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kubernetes import client


def load_core_v1() -> "client.CoreV1Api":
    try:
        from kubernetes import client, config
    except ImportError as exc:
        raise RuntimeError("kubernetes package not installed") from exc

    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return client.CoreV1Api()


def load_apps_v1() -> "client.AppsV1Api":
    try:
        from kubernetes import client, config
    except ImportError as exc:
        raise RuntimeError("kubernetes package not installed") from exc

    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    return client.AppsV1Api()
