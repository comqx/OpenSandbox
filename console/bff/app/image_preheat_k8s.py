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

"""Kubernetes adapter for one-shot image preheat pods."""

from __future__ import annotations

import json
from typing import Any

from app.image_preheat import ImagePreheatError
from app.k8s_client import load_core_v1


def _api_message(exc: Any) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8", errors="replace")
    if isinstance(body, str) and body:
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            return body
        if isinstance(parsed, dict) and parsed.get("message"):
            return str(parsed["message"])
    reason = getattr(exc, "reason", None)
    return str(reason or exc)


def _raise_api(exc: Any) -> None:
    status = int(getattr(exc, "status", 0) or 0)
    if status in (401, 403):
        code_status = 403
    elif status == 404:
        code_status = 404
    elif status in (409, 429):
        code_status = 409
    else:
        code_status = 502
    raise ImagePreheatError(code_status, "KUBERNETES_ERROR", _api_message(exc)) from exc


def _node_view(node: Any) -> dict[str, Any]:
    ready = False
    conditions = node.status.conditions if node.status else None
    for condition in conditions or []:
        if condition.type == "Ready" and condition.status == "True":
            ready = True
    return {
        "name": node.metadata.name,
        "ready": ready,
        "unschedulable": bool(node.spec and node.spec.unschedulable),
    }


def _pod_view(pod: Any) -> dict[str, Any]:
    statuses = pod.status.container_statuses if pod.status else None
    first = statuses[0] if statuses else None
    image_id = ""
    waiting_reason = ""
    waiting_message = ""
    terminated_reason = ""
    terminated_message = ""
    exit_code = None
    if first is not None:
        image_id = first.image_id or ""
        state = first.state
        waiting = state.waiting if state else None
        terminated = state.terminated if state else None
        if waiting is not None:
            waiting_reason = waiting.reason or ""
            waiting_message = waiting.message or ""
        if terminated is not None:
            terminated_reason = terminated.reason or ""
            terminated_message = terminated.message or ""
            exit_code = terminated.exit_code
    return {
        "name": pod.metadata.name,
        "nodeName": pod.spec.node_name if pod.spec else "",
        "imageId": image_id,
        "waitingReason": waiting_reason,
        "waitingMessage": waiting_message,
        "terminatedReason": terminated_reason,
        "terminatedMessage": terminated_message,
        "exitCode": exit_code,
        "podReason": (pod.status.reason or "") if pod.status else "",
        "phase": pod.status.phase if pod.status else "",
    }


class KubernetesPreheatClient:
    def list_nodes(self) -> list[dict[str, Any]]:
        from kubernetes.client.exceptions import ApiException

        try:
            listed = load_core_v1().list_node()
        except ApiException as exc:
            _raise_api(exc)
        except Exception as exc:
            raise ImagePreheatError(503, "KUBERNETES_UNAVAILABLE", "无法读取节点列表") from exc
        return [_node_view(node) for node in listed.items]

    def service_account_pull_secrets(self, namespace: str) -> list[str]:
        from kubernetes.client.exceptions import ApiException

        try:
            account = load_core_v1().read_namespaced_service_account("default", namespace)
        except ApiException as exc:
            if int(getattr(exc, "status", 0) or 0) == 404:
                return []
            _raise_api(exc)
        refs = account.image_pull_secrets or []
        return [ref.name for ref in refs if getattr(ref, "name", None)]

    def create_pod(self, namespace: str, body: dict[str, Any]) -> None:
        from kubernetes.client.exceptions import ApiException

        try:
            load_core_v1().create_namespaced_pod(namespace, body)
        except ApiException as exc:
            _raise_api(exc)

    def list_pods(self, namespace: str, label_selector: str) -> list[dict[str, Any]]:
        from kubernetes.client.exceptions import ApiException

        try:
            listed = load_core_v1().list_namespaced_pod(namespace, label_selector=label_selector)
        except ApiException as exc:
            _raise_api(exc)
        return [_pod_view(pod) for pod in listed.items]

    def delete_pod(self, namespace: str, name: str) -> None:
        from kubernetes.client.exceptions import ApiException

        try:
            load_core_v1().delete_namespaced_pod(name, namespace)
        except ApiException as exc:
            if int(getattr(exc, "status", 0) or 0) == 404:
                return
            _raise_api(exc)
