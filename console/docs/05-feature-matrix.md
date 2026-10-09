# Feature matrix

Core lifecycle flows go through the **BFF**; optional **server lifecycle audit** feeds PostgreSQL history. Status legend:

| Symbol | Meaning |
|--------|---------|
| ✅ | Implemented with a tested path |
| 🔶 | UI present; depends on cluster/RBAC or partial admin/tenant support |
| 📋 | Placeholder; needs future BFF or Kubernetes work |

## Phase 1 — tenant developers

| Feature | Status | BFF | Web |
|---------|--------|-----|-----|
| Tenant key login | ✅ | `/api/auth/tenant` | `/login` |
| Admin token login | ✅ | `/api/auth/admin` | `/login` |
| Sandbox list / filter | ✅ | `GET /api/sandboxes` | `/sandboxes` |
| Sandbox detail | ✅ | `GET /api/sandboxes/{id}` | `/sandboxes/:id` |
| Runtime logs | ✅ | diagnostics logs | detail / list |
| Create sandbox | ✅ | `POST /api/sandboxes` | `/sandboxes/new` |
| Renew / delete | ✅ | renew / DELETE | detail |
| Endpoint | ✅ | `.../endpoints/{port}` | detail |
| Sandbox shell | ✅ | WebSocket bridge to execd PTY | `/sandboxes/:id/shell` |
| Runtime / TTL summary | ✅ | `runtimeSummary` | list / detail |
| Pause / resume | 🔶 | pause / resume | detail |
| Tenant overview KPI | ✅ | list aggregation | `/` |
| Sandbox image list | 📋 | catalog TBD | `/images/list` (demo) |
| Mirror accel URLs | ✅ | static UI | `/history/mirror-accel` |
| Sandbox image build | 📋 | remote build TBD | `/images/sandbox-build` |

## Phase 2 — admin and platform

| Feature | Status | BFF | Web |
|---------|--------|-----|-----|
| Global sandbox list | ✅ | `/api/admin/sandboxes` | `/admin/sandboxes` |
| Runtime stats | ✅ | `/api/admin/stats/runtime` | `/` (admin) |
| Snapshots | ✅ | tenant + admin | `/snapshots` |
| Diagnostics | ✅ | logs / events | `/diagnostics` |
| Sandbox shell | ✅ | `?tenant=` PTY bridge | `/sandboxes/:id/shell` |
| Pools | ✅ | `/api/pools*` | `/pools` |
| Admin sandbox ops | ✅ | `?tenant=` proxy | `/sandboxes/:id` |
| Component health | 🔶 | K8s deployments + node-agent | `/platform/health` |
| Archive logs | 🔶 | OSS + BFF read | log tab |
| Version | ✅ | `/api/version` | `/platform/version` |
| K8s workloads / events | 🔶 | admin k8s APIs | `/platform/k8s/*` |
| Grafana settings | ✅ | platform settings API | `/platform/settings` |
| Sandbox Grafana monitor | ✅ | `.../monitor` | detail tab |

## Known limitations

1. **Pool API** is not tenant-isolated.
2. **K8s platform pages** require BFF ServiceAccount RBAC.
3. **Admin diagnostics** proxy tenant keys; define product policy for your org.
