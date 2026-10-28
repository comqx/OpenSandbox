# BFF HTTP API (SPA)

Base path: `/api`. Cookie session required except login and health.

## Authentication

### `POST /api/auth/tenant`

```json
{ "apiKey": "..." }
```

- 200: `{ "role": "tenant", "tenant": "...", "namespace": "..." }` + Set-Cookie
- 401: invalid key

### `POST /api/auth/admin`

```json
{ "adminToken": "..." }
```

- 200: `{ "role": "admin" }` + Set-Cookie

### `POST /api/auth/logout`

Clears session.

### `GET /api/auth/me`

`{ "role": "tenant"|"admin", "tenant"?, "namespace"? }`

## Tenant sandboxes

Proxies Lifecycle; responses include BFF **`runtimeSummary`**.

| Method | Path | Lifecycle |
|--------|------|-----------|
| GET | `/api/sandboxes` | `GET /sandboxes` |
| GET | `/api/sandboxes/{id}` | `GET /sandboxes/{id}` |
| POST | `/api/sandboxes` | `POST /sandboxes` |
| DELETE | `/api/sandboxes/{id}` | DELETE |
| POST | `/api/sandboxes/{id}/renew-expiration` | same |
| POST | `/api/sandboxes/{id}/pause` | same (202) |
| POST | `/api/sandboxes/{id}/resume` | same (202) |
| POST | `/api/sandboxes/{id}/snapshots` | same (202) |
| GET | `/api/sandboxes/{id}/diagnostics/logs` | query `scope` required |
| GET | `/api/sandboxes/{id}/diagnostics/events` | same |
| GET | `/api/sandboxes/{id}/logs/archive` | optional OSS archive (inline preview, may truncate) |
| GET | `/api/sandboxes/{id}/logs/archive/download` | full OSS archive file attachment |
| GET | `/api/sandboxes/{id}/endpoints/{port}` | same |
| GET | `/api/sandboxes/{id}/monitor` | Grafana embed URL |
| WS | `/api/sandboxes/{id}/shell/ws` | resolves endpoint `44772`, then bridges execd `POST /pty` and `GET /pty/{sessionId}/ws` |

### Snapshots (tenant)

| Method | Path |
|--------|------|
| GET | `/api/snapshots` |
| GET | `/api/snapshots/{id}` |
| DELETE | `/api/snapshots/{id}` |

### `runtimeSummary`

```json
{
  "wallClockSeconds": 3842,
  "remainingSeconds": 900,
  "asOf": "2026-09-28T08:00:00Z",
  "basis": "createdAt"
}
```

## Admin

### `GET /api/admin/sandboxes`

Aggregates per-tenant lists; optional `tenant=` filter. Pagination includes `tenantErrors` for partial failures.

### Admin sandbox ops

Query **`tenant`** required for `{id}` read/write, diagnostics, monitor, and shell.

`WS /api/admin/sandboxes/{id}/shell/ws?tenant=` opens the same execd PTY bridge with that tenant's API key. The browser session cookie is the only credential on the WebSocket. `BFF_SHELL_ENDPOINT_MODE=server` (default) dials the in-cluster lifecycle proxy and sends `OPEN-SANDBOX-API-KEY`. `gateway` dials the public ingress endpoint and forwards endpoint headers without the tenant API key. Closing the socket deletes the PTY session.

### Platform settings (Grafana)

- `GET /api/admin/platform/settings`
- `PATCH /api/admin/platform/settings`
- `GET|HEAD|POST /api/grafana/...` when `embedMode=proxy`. The proxy serves the dashboard page, `/public/` assets, and read-only dashboard APIs. HTML is rewritten onto this prefix so Grafana's public `root_url` stays unchanged. Admin, user, and datasource writes are rejected.

### Admin snapshots

`GET/DELETE /api/admin/snapshots[/{id}]?tenant=`

### Admin Kubernetes (read-only)

`GET /api/admin/k8s/workloads`, `GET /api/admin/k8s/events` — requires `BFF_K8S_PROBE_ENABLED` and RBAC.

### `GET /api/admin/stats/runtime`

Aggregated KPIs from admin sandbox list.

### Pools (admin)

Proxies `/v1/pools` (**not tenant-isolated**; BFF uses first tenant key in `tenants.toml`).

### `GET /api/admin/platform/summary`

Server health/version plus component placeholders.

## History

See [07-sandbox-history.md](./07-sandbox-history.md) for `/api/history/*`.

## Sandbox image catalog

Shared directory of base images. Any signed-in tenant or admin can list and edit it. Entries are stored in PostgreSQL table `console_sandbox_image_catalog` when history is enabled, otherwise in `BFF_IMAGE_CATALOG_PATH`.

| Method | Path | Body |
|--------|------|------|
| GET | `/api/images/catalog` | `{ "items", "persisted", "source" }` |
| POST | `/api/images/catalog` | `displayName`, `imageUri`, optional `scenarios` / `systemPackages` / `runtimePackages` / `maintainer` |
| PATCH | `/api/images/catalog/{id}` | same fields, partial |
| DELETE | `/api/images/catalog/{id}` | 204 |

`scenarios`, `systemPackages`, and `runtimePackages` are string lists. A comma-separated string is accepted and split. `maintainer` defaults to the admin role or the tenant name. Duplicate `imageUri` returns 409. Writes return 503 when neither the history database nor `BFF_IMAGE_CATALOG_PATH` is configured.

### Node image preheat

One-shot pull of a catalog image onto selected nodes. The BFF creates a short-lived Pod in the tenant namespace and does not call the lifecycle server. Any signed-in user can start it. A tenant session is limited to its own namespace. An admin session must pass `tenant`.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/images/catalog/{id}/preheat/nodes` | Ready, uncordoned nodes. `{ tenant, namespace, nodes: [{ name }] }` |
| POST | `/api/images/catalog/{id}/preheat` | `{ nodeNames, tenant? }` → `{ preheatId, tenant, namespace, imageUri, nodes }` |
| GET | `/api/images/catalog/{id}/preheats` | History for that image. `{ persisted, items }`. A tenant sees only their rows. Opening the list reconciles `pulling` rows, and only while a row is still `pulling`. It deletes a Pod after that update, and retries deletion for a row that is already terminal. `persisted: false` when the history database is off. |
| GET | `/api/images/catalog/preheats/{preheatId}` | Current Pod status for one preheat. Does not write history and does not delete Pods. |

Private registries use the namespace `default` ServiceAccount `imagePullSecrets`. Pull credentials created only for a sandbox are not reused. The BFF ServiceAccount needs `nodes` get/list, `serviceaccounts` get, and `pods` create/delete. See [console-bff-rbac.example.yaml](../k8s/console-bff-rbac.example.yaml).

## Sandbox image build context (Phase 2a)

Requires `BFF_HISTORY_ENABLED`, `BFF_IMAGE_BUILD_ENABLED=true`, and OSS credentials (`BFF_IMAGE_BUILD_OSS_*` or fallback `BFF_NODEAGENT_OSS_*`). A tenant session is always scoped to itself. An admin `GET /api/images/build-contexts` without `?tenant=` returns every tenant. Admin create, read, update, and delete calls still require `?tenant=`.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/images/build-contexts` | `{ persisted, source, items }` |
| POST | `/api/images/build-contexts` | `displayName`, optional `dockerfilePath` |
| GET/PATCH | `/api/images/build-contexts/{id}` | metadata + manifest (no inline file bodies) |
| PUT/GET/DELETE | `/api/images/build-contexts/{id}/files/{path}` | `encoding` + `content` (utf-8 or base64) |
| POST/GET | `/api/images/build-contexts/{id}/tar` | build or presign `context.tar` on OSS |
| POST | `/api/images/build-contexts/{id}/builds` | `{ imageName, basicStruct }` where `basicStruct` is `"1"` (amd64) or `"2"` (arm64). Packs the OSS files into an uncompressed tar and submits it to `BFF_IMAGE_BUILDER_BASE_URL`. Returns `{ taskId, contextId, imageName, basicStruct, status: "building" }` |
| GET | `/api/images/build-contexts/{id}/builds/{taskId}/logs` | `text/event-stream`. Replays builder logs. The last event without an `event` name is the result (`success`, `failed`, or `cleaned`) |
| DELETE | `/api/images/build-contexts/{id}` | remove draft row and OSS objects |

List and detail items include `latestBuild` (`null` when the draft has no job). A context can have only one `building` job; a second submit returns `409 IMAGE_BUILD_IN_PROGRESS`.

Returns `503 IMAGE_BUILD_NOT_CONFIGURED` when the feature gate or storage is unavailable. Submit returns `503 IMAGE_BUILDER_NOT_CONFIGURED` when storage or `BFF_IMAGE_BUILDER_BASE_URL` is missing.

When the log stream reports `success`, the BFF inserts `imageName` into `console_sandbox_image_catalog` (display name from the draft, truncated to 80 characters). An existing URI is left as-is. The image is still not pushed by this API. The console ingress should allow at least 3600s read time for the log stream and must not buffer `text/event-stream`.

## Health

- `GET /health` → `{ "status": "ok" }`
- `GET /api/version` → proxies server `/version`

## Errors

```json
{ "code": "UNAUTHORIZED", "message": "..." }
```

Lifecycle errors forward `code` / `message` when present.
