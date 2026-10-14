# Console sandbox image preheat

## Goal

From the sandbox image list, a signed-in user can pre-pull one catalog image onto selected nodes. The pull is one-shot. The dialog stays open and shows each node's result. This does not create a sandbox and does not change the lifecycle server, the public OpenAPI, or the SDKs.

## Entry

The image list row action **节点预热** opens a dialog. There is no new sidebar item.

- A tenant session uses that tenant's namespace. The dialog does not ask for a tenant.
- An admin session must pick a tenant. The Pod is created in that tenant's namespace.
- The node list contains only nodes that are Ready and not cordoned (`spec.unschedulable` is not true).
- After confirm, the dialog stays open and shows `pulling`, `succeeded`, or `failed` per node. It closes when every selected node has finished.

## What a preheat is

The BFF creates one Pod per selected node through the Kubernetes API. It does not call the lifecycle server.

- The Pod is pinned with `nodeName`.
- `restartPolicy` is `Never`. `activeDeadlineSeconds` is 1200.
- The container image is the catalog `imageUri`. `imagePullPolicy` is `IfNotPresent`.
- `command` is `["/opensandbox-preheat-noop"]`, so kubelet pulls the image and does not run the image entrypoint.
- `automountServiceAccountToken` is false. The Pod is not privileged and does not set `hostPath` or `hostNetwork`.
- Requests and limits are `cpu: 1m`, `memory: 1Mi`.
- Labels: `opensandbox.io/image-preheat=true`, `opensandbox.io/preheat-id`, `opensandbox.io/catalog-image-id`.
- The Pod must not carry `opensandbox.io/id`. It does not appear in the sandbox list and is not written to sandbox history.
- `imagePullSecrets` are copied from the namespace `default` ServiceAccount. The per-sandbox secret created by the lifecycle server is not reused. A private registry that only has credentials on sandbox create will fail the pull.
- The image lands in the node container runtime. Other tenants scheduled onto that node can use it afterwards.
- A node is `succeeded` when the container status has an `imageID`, or the container has already moved past the pull (`StartError`, `CreateContainerError`, `RunContainerError`, or exit code 127). The noop command is expected to fail after the image is local. `ErrImagePull` and `ImagePullBackOff` are `failed`, and the message prefers the container waiting or terminated text. Anything else still waiting is `pulling`. A `Failed` phase that never got past the pull is `failed`.
- The BFF deletes a Pod once its state is terminal. `activeDeadlineSeconds` removes a Pod if the dialog is closed early.
- If the namespace rejects Pod creation (quota, missing namespace, forbidden), that preheat request fails and Pods already created for it are deleted.

## API

All routes require a console session. The image id must exist in the shared catalog. The caller cannot submit an image URI.

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/api/images/catalog/{imageId}/preheat/nodes` | Admin: `?tenant=` required. Tenant: optional and must match the session. | `{ tenant, namespace, nodes: [{ name }] }` |
| POST | `/api/images/catalog/{imageId}/preheat` | `{ nodeNames: string[], tenant?: string }` | `{ preheatId, tenant, namespace, imageUri, nodes: [{ nodeName, podName, state, message }] }` |
| GET | `/api/images/catalog/preheats/{preheatId}` | Same tenant query rule. `preheatId` is a UUID. | Same node status list. Terminal Pods are deleted after their status is read. |

Node names on POST must all be in the current schedulable set. An empty selection is rejected.

Progress is stored only on Pod labels. There is no new database table.

## Kubernetes access

`console/k8s/console-bff-rbac.example.yaml` additionally allows:

- `nodes`: get, list
- `pods`: create, delete (get and list already exist)
- `serviceaccounts`: get

The lifecycle server is unchanged.

## UI

The dialog lists schedulable nodes with checkboxes. While a preheat is running, the node set cannot be changed and the dialog cannot be dismissed. When every node is terminal, a close button is enabled. Rows that already reached `succeeded` or `failed` stay on screen after the BFF deletes those Pods.

## Tests

BFF tests cover node filtering, tenant resolution, the Pod manifest, status interpretation, create rollback, and deletion of terminal Pods. The web test covers merging polled status into rows the server has already deleted.
