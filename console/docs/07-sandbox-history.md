# Sandbox lifecycle history

Uses **shared PostgreSQL** (e.g. database `opensandbox`). Single table **`sandbox_lifecycle_history`**:

| Writer | When | Fields |
|--------|------|--------|
| **Server** (`[store.lifecycle_audit] enabled=true`) | After successful Lifecycle create/delete (async) | tenant, image, status, timestamps, limit summary |
| **Console BFF** | Console create/list/reconcile/delete | same + `create_request`, `source=console*`, etc. |

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

BFF runs `CREATE TABLE IF NOT EXISTS sandbox_lifecycle_history` only (no import from legacy `console_sandbox_history` tables).

## Reads

History, usage, and image stats query **`sandbox_lifecycle_history`** only.

## API

See [03-bff-api.md](./03-bff-api.md) and `/api/history/*`.

## Database permissions

Role needs `SELECT, INSERT, UPDATE` on `sandbox_lifecycle_history`; snapshot counts may need `SELECT` on `snapshots`.
