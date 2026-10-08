# Sandbox lifecycle history

Uses **shared PostgreSQL** (e.g. database `opensandbox`). Single table **`sandbox_lifecycle_history`**:

| Writer | When | Fields |
|--------|------|--------|
| **Server** (`[store.lifecycle_audit] enabled=true`) | After successful Lifecycle create/delete (async) | tenant, image, status, timestamps, limit summary |
| **Console BFF** | Console create/list/reconcile/delete | same + `create_request`, `source=console*`, etc. |

SDK/script calls to the server are recorded by server audit. With audit enabled, set **`BFF_HISTORY_RECONCILE_ON_READ=false`** so history pages do not full-scan Lifecycle on every read.

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
| `BFF_HISTORY_RECONCILE_ON_READ` | default `true`; prefer `false` when server audit is on |

BFF runs `CREATE TABLE IF NOT EXISTS sandbox_lifecycle_history` only (no import from legacy `console_sandbox_history` tables).

## Reads

History, usage, and image stats query **`sandbox_lifecycle_history`** only.

## API

See [03-bff-api.md](./03-bff-api.md) and `/api/history/*`.

## Database permissions

Role needs `SELECT, INSERT, UPDATE` on `sandbox_lifecycle_history`; snapshot counts may need `SELECT` on `snapshots`.
