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

"""One-shot node image preheat. Pods pull a catalog image and then exit."""

from __future__ import annotations

import hashlib
import uuid
from typing import Any, Protocol

from app.config import Settings
from app.image_catalog import list_images
from app.tenants import get_tenant_by_name

PREHEAT_LABEL = "opensandbox.io/image-preheat"
PREHEAT_ID_LABEL = "opensandbox.io/preheat-id"
CATALOG_IMAGE_LABEL = "opensandbox.io/catalog-image-id"
NOOP_COMMAND = ["/opensandbox-preheat-noop"]
ACTIVE_DEADLINE_SECONDS = 1200
PULL_FAILURE_REASONS = {"ErrImagePull", "ImagePullBackOff"}
# These reasons are produced after the image is already on the node. The noop
# command is expected to fail here, so they mean the pull succeeded.
POST_PULL_REASONS = {"StartError", "CreateContainerError", "RunContainerError"}
_TERMINAL = {"succeeded", "failed"}


class ImagePreheatError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


class PreheatClient(Protocol):
    def list_nodes(self) -> list[dict[str, Any]]: ...

    def service_account_pull_secrets(self, namespace: str) -> list[str]: ...

    def create_pod(self, namespace: str, body: dict[str, Any]) -> None: ...

    def list_pods(self, namespace: str, label_selector: str) -> list[dict[str, Any]]: ...

    def delete_pod(self, namespace: str, name: str) -> None: ...


def schedulable_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [node for node in nodes if node.get("ready") and not node.get("unschedulable")]


def resolve_preheat_tenant(
    payload: dict[str, Any],
    tenants_path: str,
    requested: str | None,
) -> tuple[str, str]:
    role = payload.get("role")
    if role == "tenant":
        name = str(payload.get("tenant") or "")
        namespace = str(payload.get("namespace") or "")
        if requested and requested != name:
            raise ImagePreheatError(403, "FORBIDDEN", "只能预热自己的租户")
        if not name or not namespace:
            raise ImagePreheatError(400, "INVALID_TENANT", "会话里没有租户")
        return name, namespace
    if role == "admin":
        tenant_name = (requested or "").strip()
        if not tenant_name:
            raise ImagePreheatError(400, "TENANT_REQUIRED", "请选择租户")
        record = get_tenant_by_name(tenants_path, tenant_name)
        if record is None:
            raise ImagePreheatError(404, "TENANT_NOT_FOUND", "租户不存在")
        return record.name, record.namespace
    raise ImagePreheatError(403, "FORBIDDEN", "需要登录")


def pod_name(preheat_id: str, node_name: str) -> str:
    digest = hashlib.sha256(f"{preheat_id}/{node_name}".encode()).hexdigest()[:12]
    return f"preheat-{digest}"


def build_preheat_pod(
    *,
    preheat_id: str,
    image_id: str,
    image_uri: str,
    node_name: str,
    namespace: str,
    pull_secrets: list[str],
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "activeDeadlineSeconds": ACTIVE_DEADLINE_SECONDS,
        "nodeName": node_name,
        "automountServiceAccountToken": False,
        "containers": [
            {
                "name": "preheat",
                "image": image_uri,
                "imagePullPolicy": "IfNotPresent",
                "command": list(NOOP_COMMAND),
                "resources": {
                    "requests": {"cpu": "1m", "memory": "1Mi"},
                    "limits": {"cpu": "1m", "memory": "1Mi"},
                },
            }
        ],
    }
    if pull_secrets:
        spec["imagePullSecrets"] = [{"name": name} for name in pull_secrets]
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": pod_name(preheat_id, node_name),
            "namespace": namespace,
            "labels": {
                PREHEAT_LABEL: "true",
                PREHEAT_ID_LABEL: preheat_id,
                CATALOG_IMAGE_LABEL: image_id,
            },
        },
        "spec": spec,
    }


def interpret_pod(pod: dict[str, Any]) -> dict[str, str]:
    if str(pod.get("imageId") or "").strip():
        return {"state": "succeeded", "message": ""}
    waiting_reason = str(pod.get("waitingReason") or "")
    terminated_reason = str(pod.get("terminatedReason") or "")
    message = str(pod.get("waitingMessage") or "") or str(pod.get("terminatedMessage") or "")
    if waiting_reason in PULL_FAILURE_REASONS or terminated_reason in PULL_FAILURE_REASONS:
        reason = waiting_reason or terminated_reason
        return {"state": "failed", "message": message or reason}
    if waiting_reason in POST_PULL_REASONS or terminated_reason in POST_PULL_REASONS or pod.get("exitCode") == 127:
        return {"state": "succeeded", "message": ""}
    if pod.get("phase") == "Failed":
        reason = waiting_reason or terminated_reason or str(pod.get("podReason") or "")
        return {"state": "failed", "message": message or reason or "拉取未完成"}
    return {"state": "pulling", "message": ""}


def _catalog_image(image_id: str) -> dict[str, Any]:
    for item in list_images().get("items") or []:
        if item.get("id") == image_id:
            return item
    raise ImagePreheatError(404, "IMAGE_NOT_FOUND", "镜像不在目录中")


def _node_names(body: dict[str, Any]) -> list[str]:
    raw = body.get("nodeNames")
    if not isinstance(raw, list):
        raise ImagePreheatError(400, "NODES_REQUIRED", "请选择节点")
    names: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = str(item).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        names.append(name)
    if not names:
        raise ImagePreheatError(400, "NODES_REQUIRED", "请选择节点")
    return names


class ImagePreheatService:
    def __init__(self, settings: Settings, client: PreheatClient) -> None:
        self._settings = settings
        self._client = client

    def list_nodes(self, payload: dict[str, Any], image_id: str, requested_tenant: str | None) -> dict[str, Any]:
        _catalog_image(image_id)
        tenant, namespace = resolve_preheat_tenant(payload, self._settings.tenants_toml_path, requested_tenant)
        nodes = schedulable_nodes(self._client.list_nodes())
        return {
            "tenant": tenant,
            "namespace": namespace,
            "nodes": [{"name": str(node.get("name") or "")} for node in nodes if node.get("name")],
        }

    def start(self, payload: dict[str, Any], image_id: str, body: dict[str, Any]) -> dict[str, Any]:
        tenant, namespace = resolve_preheat_tenant(
            payload,
            self._settings.tenants_toml_path,
            body.get("tenant") if isinstance(body.get("tenant"), str) else None,
        )
        image = _catalog_image(image_id)
        node_names = _node_names(body)
        allowed = {str(node.get("name")) for node in schedulable_nodes(self._client.list_nodes())}
        rejected = [name for name in node_names if name not in allowed]
        if rejected:
            raise ImagePreheatError(400, "NODE_NOT_SCHEDULABLE", f"节点不可调度: {', '.join(rejected)}")
        secrets = self._client.service_account_pull_secrets(namespace)
        preheat_id = str(uuid.uuid4())
        created: list[str] = []
        try:
            for node_name in node_names:
                pod = build_preheat_pod(
                    preheat_id=preheat_id,
                    image_id=image_id,
                    image_uri=str(image["imageUri"]),
                    node_name=node_name,
                    namespace=namespace,
                    pull_secrets=secrets,
                )
                self._client.create_pod(namespace, pod)
                created.append(pod["metadata"]["name"])
        except ImagePreheatError:
            self._rollback(namespace, created)
            raise
        except Exception as exc:
            self._rollback(namespace, created)
            raise ImagePreheatError(502, "PREHEAT_FAILED", "创建预热 Pod 失败") from exc
        return {
            "preheatId": preheat_id,
            "tenant": tenant,
            "namespace": namespace,
            "imageUri": image["imageUri"],
            "nodes": [
                {
                    "nodeName": node_name,
                    "podName": pod_name(preheat_id, node_name),
                    "state": "pulling",
                    "message": "",
                }
                for node_name in node_names
            ],
        }

    def get(self, payload: dict[str, Any], preheat_id: str, requested_tenant: str | None) -> dict[str, Any]:
        try:
            uuid.UUID(preheat_id)
        except ValueError as exc:
            raise ImagePreheatError(400, "INVALID_PREHEAT", "预热任务编号无效") from exc
        tenant, namespace = resolve_preheat_tenant(payload, self._settings.tenants_toml_path, requested_tenant)
        pods = self._client.list_pods(namespace, f"{PREHEAT_ID_LABEL}={preheat_id}")
        nodes: list[dict[str, str]] = []
        for pod in pods:
            interpreted = interpret_pod(pod)
            name = str(pod.get("name") or "")
            nodes.append(
                {
                    "nodeName": str(pod.get("nodeName") or ""),
                    "podName": name,
                    "state": interpreted["state"],
                    "message": interpreted["message"],
                }
            )
            if interpreted["state"] in _TERMINAL and name:
                self._client.delete_pod(namespace, name)
        return {"preheatId": preheat_id, "tenant": tenant, "namespace": namespace, "nodes": nodes}

    def _rollback(self, namespace: str, names: list[str]) -> None:
        for name in names:
            try:
                self._client.delete_pod(namespace, name)
            except Exception:
                continue
