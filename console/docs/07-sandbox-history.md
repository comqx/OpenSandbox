# Sandbox lifecycle history

Uses **shared PostgreSQL** (e.g. database `opensandbox`). Single table **`sandbox_lifecycle_history`**:

| Writer | When | Fields |
|--------|------|--------|
| **Server** (`[store.lifecycle_audit] enabled=true`) | After successful Lifecycle create/delete (async) | tenant, image, status, timestamps, limit summary, `metadata` (sandbox labels) |
| **Console BFF** | Console create/list/reconcile/delete | same columns except it does not write `metadata`; `create_request`, `source=console*` |

SDK/script calls to the server are recorded by server audit on create and delete only. The BFF polls Lifecycle every **`BFF_HISTORY_RECONCILE_INTERVAL_SECONDS`** (default 600) and closes sandboxes that expired or disappeared without a delete call. A row with `expires_at` already in the past is closed at that expiration time, not at the poll clock. History pages only read the table. Set **`BFF_HISTORY_RECONCILE_ON_READ=true`** only if a history request should scan Lifecycle itself. Set the interval to `0` to disable the poller; rows then stay `Running` until an explicit delete.

## Enable

**Server** (`configuration.md` / Helm `configToml`):

```toml
[store]
type = "postgresql"

[store.lifecycle_audit]
enabled = true
```

**BFF**:

| Variable | Description |
|----------|-------------|
| `BFF_HISTORY_ENABLED` | `true` |
| `BFF_HISTORY_DATABASE_URL` | Same DSN as server store |
| `BFF_HISTORY_RECONCILE_ON_READ` | default `false`. History reads do not scan Lifecycle |
| `BFF_HISTORY_RECONCILE_INTERVAL_SECONDS` | default `600`. Poll interval; `0` disables it |

BFF runs `CREATE TABLE IF NOT EXISTS` for `sandbox_lifecycle_history`, `console_platform_settings`, and `console_sandbox_image_catalog` (no import from legacy `console_sandbox_history` tables). The image catalog is the shared list on **沙箱镜像列表**; any signed-in user can read and edit it. It is not derived from sandbox history.

## Reads

History, usage, and image stats query **`sandbox_lifecycle_history`** only.

`GET /api/history/created-series` requires `from` and `to` (UTC, `to` exclusive) and `bucket=day|month`. It counts rows by `COALESCE(lifecycle_created_at, first_recorded_at)` falling in each UTC bucket. The response is `points`, `series[]` (`tenant`, `counts` aligned to `points`), and `totals`. A day bucket longer than 120 days is rejected. A window longer than 36 buckets drops leading empty buckets so all-time monthly charts start at the first creation. This is create-time trend, separate from overlap duration on `/history/stats`.

`GET /api/history/stats` accepts optional `from` and `to` (UTC, `to` exclusive). With both, counts and durations include only rows whose lifetime overlaps `[from, to)`, and duration is clipped to that window. Without them, totals use stored `wall_clock_seconds` for the whole history. The overview always sends a window, including a wide one for 历史累计, so its duration stays on the overlap formula. The response includes `tenants[]` (`tenant`, `totalRecords`, `activeRecords`, `totalWallClockSeconds`, `avgWallClockSeconds`). `activeRecords` is still “not ended now”, among the rows in scope.

Usage CPU·秒 and 内存·Gi·秒 skip rows that have no create-time `resourceLimits`. Those rows still count toward sandbox count and overlap duration. The API does not fill them with 1 core / 512Mi. `totals.limitsMissing` is how many in-scope rows were skipped for at least one of those two metrics.

`metadata` is the sandbox label map. The Server writes it on lifecycle create and delete. History list accepts `label`: a case-insensitive substring matched against each key, value, or `key=value`. Space-separated terms are AND. Rows created before that Server change have no labels unless `create_request.metadata` was stored by the console. The same list accepts `sandboxId`: a case-insensitive substring of the sandbox id (`%` and `_` are matched literally).

`GET /api/history/resource-recommendations` uses the same tenant scope and optional `label` / `sandboxId` filters. Query `window=7d|15d` (default `7d`) selects a rolling UTC window, or pass `from` and `to` (UTC, `to` exclusive) like other history endpoints. Optional `reconcile=false` skips the lifecycle reconcile pass when `BFF_HISTORY_RECONCILE_ON_READ` is enabled. The BFF loads matching history rows (including terminated sandboxes; up to 2000 per run). Recommendation sampling ends a still-open row at the earliest of `now`, the window end, and `expires_at`. History list overlap and usage totals still count an unclosed row through `now`. Prometheus `query_range` calls are batched by namespace (at most 30 Pod names per PromQL via `pod=~"{{pod_regex}}"`, submitted with HTTP POST). Ranges longer than 7 days are split so each query stays under Prometheus’s 11000-point cap at a 60s step. Samples are clipped to that sandbox’s active interval. Each sandbox is one vote: it needs at least 3 CPU and 3 memory samples. CPU request is the p75 of the 2-minute rate inside the sandbox, then the p75 across sandboxes. Memory request is the p95 of working set inside the sandbox, then the configured percentile across sandboxes (default 95). Limits use the max 1-minute CPU rate and the max working set inside each sandbox, then that same percentile across sandboxes, multiplied by the peak headroom (default CPU 1.2, memory 1.15) and raised to the configured floor. Default PromQL targets `container="sandbox"`. Pod names tried are `<sandboxId>-0` and legacy `sandbox-<sandboxId>-0`. A cohort needs 5 qualified sandboxes, or 1 when `sandboxId` is set. Fewer than 20 qualified sandboxes returns `confidence: "low"`. The response `aggregation` is `per_sandbox_percentile`, with `distribution`, `warnings`, and per-sandbox summaries. Older saved runs keep `aggregation: "pooled_percentile"`. Configure Prometheus URL, PromQL templates (`{{namespace}}`, `{{pod_regex}}`), percentile, and peak headroom in **Admin → 系统设置 → 资源推荐**. Settings saved before `schemaVersion: 2` do not reuse the old limit ratios as headroom.

Console navigation groups **沙箱列表**, **申请历史**, and **资源推荐** under the **沙箱** sidebar submenu. **申请历史 → 计算沙箱推荐配置** calls `POST /api/history/resource-recommendation-runs` with the same query parameters as the GET above: it computes once and persists the full JSON result plus filter metadata in `sandbox_resource_recommendation_runs`. List saved runs with `GET /api/history/resource-recommendation-runs` (`page`, `pageSize`, optional `tenant` for admins) and fetch one with `GET /api/history/resource-recommendation-runs/{id}`.

## API

See [03-bff-api.md](./03-bff-api.md) and `/api/history/*`.

## Database permissions

Role needs `SELECT, INSERT, UPDATE` on `sandbox_lifecycle_history`; snapshot counts may need `SELECT` on `snapshots`. The image catalog table is created by the BFF, so the same role needs `SELECT, INSERT, UPDATE, DELETE` on `console_sandbox_image_catalog`.
