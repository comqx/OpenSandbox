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

from types import SimpleNamespace

import pytest

from app.config import Settings
from app.image_catalog import create_image, init_image_catalog
from app.image_preheat import (
    ImagePreheatError,
    ImagePreheatService,
    build_preheat_pod,
    interpret_pod,
    resolve_preheat_tenant,
    schedulable_nodes,
)


def _settings(tmp_path) -> Settings:
    return Settings(
        tenants_toml_path=str(tmp_path / "tenants.toml"),
        bff_session_secret="x" * 32,
        bff_admin_token="token",
        bff_history_enabled=False,
        bff_image_catalog_path=str(tmp_path / "catalog.json"),
    )


def _write_tenants(tmp_path):
    path = tmp_path / "tenants.toml"
    path.write_text(
        '[[tenants]]\nname = "acme"\nnamespace = "acme-ns"\napi_keys = ["tenant-key"]\n',
        encoding="utf-8",
    )
    return path


def test_schedulable_nodes_keep_ready_uncordoned_nodes():
    nodes = schedulable_nodes(
        [
            {"name": "ready", "ready": True, "unschedulable": False},
            {"name": "cordoned", "ready": True, "unschedulable": True},
            {"name": "not-ready", "ready": False, "unschedulable": False},
        ]
    )
    assert [node["name"] for node in nodes] == ["ready"]


def test_resolve_preheat_tenant_scopes_the_session(tmp_path):
    path = str(_write_tenants(tmp_path))
    assert resolve_preheat_tenant(
        {"role": "tenant", "tenant": "acme", "namespace": "acme-ns"},
        path,
        None,
    ) == ("acme", "acme-ns")
    with pytest.raises(ImagePreheatError) as forbidden:
        resolve_preheat_tenant(
            {"role": "tenant", "tenant": "acme", "namespace": "acme-ns"},
            path,
            "other",
        )
    assert forbidden.value.status_code == 403
    with pytest.raises(ImagePreheatError) as missing:
        resolve_preheat_tenant({"role": "admin"}, path, None)
    assert missing.value.status_code == 400
    assert resolve_preheat_tenant({"role": "admin"}, path, "acme") == ("acme", "acme-ns")


def test_build_preheat_pod_pulls_without_starting_a_sandbox():
    pod = build_preheat_pod(
        preheat_id="11111111-1111-1111-1111-111111111111",
        image_id="22222222-2222-2222-2222-222222222222",
        image_uri="hub.example.com/python:3.12",
        node_name="node-a",
        namespace="acme-ns",
        pull_secrets=["registry-pull"],
    )
    labels = pod["metadata"]["labels"]
    assert "opensandbox.io/id" not in labels
    assert labels["opensandbox.io/image-preheat"] == "true"
    assert labels["opensandbox.io/preheat-id"] == "11111111-1111-1111-1111-111111111111"
    container = pod["spec"]["containers"][0]
    assert pod["spec"]["nodeName"] == "node-a"
    assert pod["spec"]["restartPolicy"] == "Never"
    assert pod["spec"]["automountServiceAccountToken"] is False
    assert pod["spec"]["activeDeadlineSeconds"] == 1200
    assert pod["spec"]["imagePullSecrets"] == [{"name": "registry-pull"}]
    assert container["image"] == "hub.example.com/python:3.12"
    assert container["imagePullPolicy"] == "IfNotPresent"
    assert container["command"] == ["/opensandbox-preheat-noop"]
    assert "securityContext" not in container
    assert pod["spec"].get("hostNetwork") is not True


@pytest.mark.parametrize(
    ("pod", "state"),
    [
        ({"imageId": "sha256:abc", "waitingReason": "", "phase": "Pending"}, "succeeded"),
        (
            {
                "imageId": "",
                "waitingReason": "ImagePullBackOff",
                "waitingMessage": "denied",
                "phase": "Pending",
            },
            "failed",
        ),
        ({"imageId": "", "waitingReason": "ContainerCreating", "phase": "Pending"}, "pulling"),
        ({"imageId": "", "waitingReason": "", "phase": "Failed"}, "failed"),
        (
            {
                "imageId": "",
                "waitingReason": "",
                "terminatedReason": "StartError",
                "terminatedMessage": "executable file not found",
                "phase": "Failed",
            },
            "succeeded",
        ),
    ],
)
def test_interpret_pod(pod, state):
    result = interpret_pod(pod)
    assert result["state"] == state
    if state == "failed" and pod.get("waitingReason") == "ImagePullBackOff":
        assert result["message"] == "denied"


def test_pod_view_reads_a_terminated_start_error():
    from app.image_preheat_k8s import _pod_view

    pod = SimpleNamespace(
        metadata=SimpleNamespace(name="preheat-1"),
        spec=SimpleNamespace(node_name="node-a"),
        status=SimpleNamespace(
            phase="Failed",
            reason="",
            container_statuses=[
                SimpleNamespace(
                    image_id="",
                    state=SimpleNamespace(
                        waiting=None,
                        terminated=SimpleNamespace(
                            reason="StartError",
                            message="executable file not found",
                            exit_code=127,
                        ),
                    ),
                )
            ],
        ),
    )
    assert interpret_pod(_pod_view(pod))["state"] == "succeeded"


def test_failed_pod_keeps_the_terminated_message():
    result = interpret_pod(
        {
            "imageId": "",
            "waitingReason": "",
            "waitingMessage": "",
            "terminatedReason": "Error",
            "terminatedMessage": "disk full",
            "phase": "Failed",
        }
    )
    assert result == {"state": "failed", "message": "disk full"}


class FakePreheatClient:
    def __init__(
        self,
        nodes: list[dict],
        secrets: dict[str, list[str]] | None = None,
        fail_nodes: set[str] | None = None,
    ):
        self.nodes = nodes
        self.secrets = secrets or {}
        self.fail_nodes = fail_nodes or set()
        self.created: list[dict] = []
        self.deleted: list[tuple[str, str]] = []

    def list_nodes(self) -> list[dict]:
        return list(self.nodes)

    def service_account_pull_secrets(self, namespace: str) -> list[str]:
        return list(self.secrets.get(namespace, []))

    def create_pod(self, namespace: str, body: dict) -> None:
        node_name = body["spec"]["nodeName"]
        if node_name in self.fail_nodes:
            raise ImagePreheatError(409, "POD_REJECTED", "exceeded quota")
        self.created.append(
            {
                "namespace": namespace,
                "body": body,
                "imageId": "",
                "waitingReason": "",
                "waitingMessage": "",
                "phase": "Pending",
            }
        )

    def list_pods(self, namespace: str, label_selector: str) -> list[dict]:
        preheat_id = label_selector.split("=", 1)[1]
        rows = []
        for pod in self.created:
            labels = pod["body"]["metadata"]["labels"]
            if pod["namespace"] == namespace and labels["opensandbox.io/preheat-id"] == preheat_id:
                rows.append(
                    {
                        "name": pod["body"]["metadata"]["name"],
                        "nodeName": pod["body"]["spec"]["nodeName"],
                        "imageId": pod["imageId"],
                        "waitingReason": pod["waitingReason"],
                        "waitingMessage": pod.get("waitingMessage", ""),
                        "phase": pod["phase"],
                    }
                )
        return rows

    def delete_pod(self, namespace: str, name: str) -> None:
        self.deleted.append((namespace, name))
        self.created = [
            pod
            for pod in self.created
            if not (pod["namespace"] == namespace and pod["body"]["metadata"]["name"] == name)
        ]


def test_start_creates_one_pod_per_selected_node_and_rejects_others(tmp_path):
    _write_tenants(tmp_path)
    settings = _settings(tmp_path)
    init_image_catalog(settings)
    image = create_image({"displayName": "Python", "imageUri": "hub.example.com/python:3.12"}, "acme")
    client = FakePreheatClient(
        [
            {"name": "node-a", "ready": True, "unschedulable": False},
            {"name": "node-b", "ready": True, "unschedulable": False},
            {"name": "cordoned", "ready": True, "unschedulable": True},
        ],
        {"acme-ns": ["registry-pull"]},
    )
    service = ImagePreheatService(settings, client)
    started = service.start(
        {"role": "tenant", "tenant": "acme", "namespace": "acme-ns"},
        image["id"],
        {"nodeNames": ["node-b", "node-a"]},
    )
    assert started["namespace"] == "acme-ns"
    assert started["imageUri"] == "hub.example.com/python:3.12"
    assert [node["nodeName"] for node in started["nodes"]] == ["node-b", "node-a"]
    assert all(node["state"] == "pulling" for node in started["nodes"])
    assert client.created[0]["body"]["spec"]["imagePullSecrets"] == [{"name": "registry-pull"}]
    with pytest.raises(ImagePreheatError) as rejected:
        service.start(
            {"role": "tenant", "tenant": "acme", "namespace": "acme-ns"},
            image["id"],
            {"nodeNames": ["cordoned"]},
        )
    assert rejected.value.status_code == 400


def test_get_deletes_terminal_pods_and_start_rolls_back(tmp_path):
    _write_tenants(tmp_path)
    settings = _settings(tmp_path)
    init_image_catalog(settings)
    image = create_image({"displayName": "Python", "imageUri": "hub.example.com/python:3.12"}, "acme")
    client = FakePreheatClient(
        [
            {"name": "node-a", "ready": True, "unschedulable": False},
            {"name": "node-b", "ready": True, "unschedulable": False},
        ]
    )
    service = ImagePreheatService(settings, client)
    started = service.start(
        {"role": "admin"},
        image["id"],
        {"tenant": "acme", "nodeNames": ["node-a", "node-b"]},
    )
    client.created[0]["imageId"] = "sha256:pulled"
    client.created[1]["waitingReason"] = "ErrImagePull"
    client.created[1]["waitingMessage"] = "unauthorized"
    status = service.get({"role": "admin"}, started["preheatId"], "acme")
    assert [node["state"] for node in status["nodes"]] == ["succeeded", "failed"]
    assert status["nodes"][1]["message"] == "unauthorized"
    assert client.created == []
    assert len(client.deleted) == 2

    failing = FakePreheatClient(
        [
            {"name": "node-a", "ready": True, "unschedulable": False},
            {"name": "node-b", "ready": True, "unschedulable": False},
        ],
        fail_nodes={"node-b"},
    )
    with pytest.raises(ImagePreheatError):
        ImagePreheatService(settings, failing).start(
            {"role": "tenant", "tenant": "acme", "namespace": "acme-ns"},
            image["id"],
            {"nodeNames": ["node-a", "node-b"]},
        )
    assert failing.created == []
    assert len(failing.deleted) == 1
