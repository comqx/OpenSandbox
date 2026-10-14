# Console sandbox image preheat

## Goal

From the sandbox image list, a signed-in user can pre-pull one catalog image onto selected nodes. The pull is one-shot. Confirm closes the dialog; results are read later from preheat history. This does not create a sandbox and does not change the lifecycle server, the public OpenAPI, or the SDKs.

## Entry

The image list row action **节点预热** opens a dialog. There is no new sidebar item.

- A tenant session uses that tenant's namespace. The dialog does not ask for a tenant.
- An admin session must pick a tenant. The Pod is created in that tenant's namespace.
- The node list contains only nodes that are Ready and not cordoned (`spec.unschedulable` is not true).
- After confirm, the dialog closes. The pull continues in the cluster. Results are read from **预热历史** on the same image row.

## What a preheat is

The BFF creates one Pod per selected node through the Kubernetes API. It does not call the lifecycle server.

- The Pod is pinned with `nodeName`.
- `restartPolicy` is `Never`. `activeDeadlineSeconds` is 1200.
- The container image is the catalog `imageUri`. `imagePullPolicy` is `IfNotPresent`.
- `command` is `["/opensandbox-preheat-noop"]`, so kubelet pulls the image and does not run the image entrypoint.
- `automountServiceAccountToken` is false. The Pod is not privileged and does not set `hostPath` or `hostNetwork`.
- Requests and limits are `cpu: 100m`, `memory: 512Mi`. A 1Mi limit OOM-kills the pod sandbox before the image pull starts.
- Labels: `opensandbox.io/image-preheat=true`, `opensandbox.io/preheat-id`, `opensandbox.io/catalog-image-id`.
- The Pod must not carry `opensandbox.io/id`. It does not appear in the sandbox list and is not written to sandbox history.
- `imagePullSecrets` are copied from the namespace `default` ServiceAccount. The per-sandbox secret created by the lifecycle server is not reused. A private registry that only has credentials on sandbox create will fail the pull.
- The image lands in the node container runtime. Other tenants scheduled onto that node can use it afterwards.
- A node is `succeeded` when the container status has an `imageID`, or the container has already moved past the pull (`StartError`, `CreateContainerError`, `RunContainerError`, or exit code 127). The noop command is expected to fail after the image is local. `ErrImagePull` and `ImagePullBackOff` are `failed`, and the message prefers the container waiting or terminated text. Anything else still waiting is `pulling`. A `Failed` phase that never got past the pull is `failed`.
- Each selected node is one row in `console_image_preheat` when the history database is enabled. Opening **预热历史** reconciles `pulling` rows from the remaining Pods. A row moves to `succeeded` or `failed` only while it is still `pulling`, so a later reconcile cannot overwrite a finished row after its Pod is gone. The BFF then deletes that Pod. A later open retries deletion when the row is already terminal and the Pod is still there. Without the history database, preheat can still start, and the history dialog says it is unavailable.
- `activeDeadlineSeconds` stops the container. It does not delete the Pod object. A Pod stays until history reconcile deletes it, or until someone deletes it by hand.
- If the namespace rejects Pod creation (quota, missing namespace, forbidden), that preheat request fails and Pods already created for it are deleted.

## API

All routes require a console session. The image id must exist in the shared catalog. The caller cannot submit an image URI.

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/api/images/catalog/{imageId}/preheat/nodes` | Admin: `?tenant=` required. Tenant: optional and must match the session. | `{ tenant, namespace, nodes: [{ name }] }` |
| POST | `/api/images/catalog/{imageId}/preheat` | `{ nodeNames: string[], tenant?: string }` | `{ preheatId, tenant, namespace, imageUri, nodes: [{ nodeName, podName, state, message }] }` |
| GET | `/api/images/catalog/{imageId}/preheats` | Tenant sessions see only their rows. | `{ persisted, items }`. Reconciles pulling rows and deletes finished Pods. `persisted: false` when history is off. |
| GET | `/api/images/catalog/preheats/{preheatId}` | Same tenant query rule. `preheatId` is a UUID. | Current Pod status only. This route does not write history and does not delete Pods. |

Node names on POST must all be in the current schedulable set. An empty selection is rejected.

When history is enabled, each node is a row in `console_image_preheat`. The console reads that table. The single-preheat route only reports Pods that still exist.

## Kubernetes access

`console/k8s/console-bff-rbac.example.yaml` additionally allows:

- `nodes`: get, list
- `pods`: create, delete (get and list already exist)
- `serviceaccounts`: get

The lifecycle server is unchanged.

## UI

**节点预热** lists schedulable nodes with checkboxes. Confirm starts the pull and closes the dialog. Changing tenant clears the previous selection before the new node list loads. **预热历史** shows one row per node. While any row is still pulling, it refreshes every 3 seconds. A failed refresh does not repeat an error toast.

## Tests

BFF tests cover node filtering, tenant resolution, the Pod manifest, status interpretation, create rollback, history reconcile, a second reconcile leaving a finished row unchanged, and a later open deleting a Pod whose first delete failed. Reading one preheat does not delete its Pods.
