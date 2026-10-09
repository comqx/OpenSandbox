# BFF configuration and secrets

## Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LIFECYCLE_API_BASE` | yes | Lifecycle root including `/v1`, e.g. `http://opensandbox-server.opensandbox-system.svc:8090/v1` |
| `TENANTS_TOML_PATH` | yes | Path to **`tenants.toml`** (same content as server mount) |
| `BFF_SESSION_SECRET` | yes | Session cookie signing secret (≥32 random chars) |
| `BFF_ADMIN_TOKEN` | yes | Admin login password; **never** in frontend build |
| `BFF_COOKIE_SECURE` | no | Set `true` behind HTTPS |
| `BFF_CORS_ORIGINS` | no | Comma-separated SPA origins; `*` dev only |
| `BFF_AGGREGATE_CACHE_SECONDS` | no | Admin list cache; default `0` |
| `BFF_HTTP_TIMEOUT_SECONDS` | no | Upstream timeout; default `30` |
| `BFF_EXECD_PROTOCOL` | no | Scheme for execd endpoints that omit one. Empty follows `LIFECYCLE_API_BASE` (`http` or `https`) |

### Optional: node-agent integration

| Variable | Default | Description |
|----------|---------|-------------|
| `BFF_K8S_PROBE_ENABLED` | `false` | Platform probes, node-agent, workloads/events APIs |
| `BFF_K8S_INSECURE_SKIP_TLS_VERIFY` | `false` | Skip Kubernetes API TLS verify (temporary; independent of server `[kubernetes] insecure_skip_tls_verify`) |
| `BFF_K8S_SYSTEM_NAMESPACE` | `opensandbox-system` | Controller/ingress namespace |
| `BFF_K8S_CONTROLLER_DEPLOYMENT` | `opensandbox-controller-manager` | Match `kubectl get deploy -n opensandbox-system` |
| `BFF_K8S_INGRESS_DEPLOYMENT` | `opensandbox-ingress-gateway` | Same |
| `BFF_K8S_NODE_AGENT_NAMESPACE` | `opensandbox-system` | DaemonSet namespace |
| `BFF_K8S_NODE_AGENT_LABEL_SELECTOR` | `app.kubernetes.io/component=node-agent` | Pod selector |
| `BFF_K8S_NODE_AGENT_PROBE_PORT` | `8080` | node-agent health port |
| `BFF_NODEAGENT_ARCHIVE_ENABLED` | `false` | Enable `GET .../logs/archive` |
| `BFF_NODEAGENT_CLUSTER_ID` | `dev-cluster` | Align with node-agent Helm `clusterID` |
| `BFF_NODEAGENT_OSS_*` | empty | Read-only OSS credentials (same key layout as node-agent writer) |
| `BFF_NODEAGENT_ARCHIVE_MAX_BYTES` | `524288` | Max bytes per archive response |

In-cluster BFF needs [console-bff-rbac.example.yaml](../k8s/console-bff-rbac.example.yaml) to list pods. Archive logs require node-agent **OSS sink** (file sink on hostPath is not readable cluster-wide).

### Optional: sandbox history (PostgreSQL)

| Variable | Default | Description |
|----------|---------|-------------|
| `BFF_HISTORY_ENABLED` | `false` | Enable `sandbox_lifecycle_history` and `/api/history/*` |
| `BFF_HISTORY_DATABASE_URL` | empty | Same DB as server `[store.postgresql]`; see [07-sandbox-history.md](./07-sandbox-history.md) |
| `BFF_HISTORY_RECONCILE_ON_READ` | `true` | Lifecycle reconcile on history reads; set `false` when server `[store.lifecycle_audit]` is enabled |

### Optional: Grafana sandbox monitor

| Variable | Default | Description |
|----------|---------|-------------|
| `BFF_GRAFANA_ENABLED` | `false` | Sandbox detail **Monitor** tab |
| `BFF_GRAFANA_BASE_URL` | empty | e.g. `https://grafana.example.com` |
| `BFF_GRAFANA_DASHBOARD_SLUG` | `opensandbox-pod-node` | Dashboard URL segment |
| `BFF_GRAFANA_DASHBOARD_UID` | empty | Dashboard UID |
| `BFF_GRAFANA_REFRESH` | `30s` | Embed refresh query param |
| `BFF_GRAFANA_EMBED_MODE` | `direct` | `direct` iframe or `proxy` via BFF `/api/grafana/...` |
| `BFF_GRAFANA_VAR_*` | see `.env.example` | Template variable names |
| `BFF_GRAFANA_DATASOURCE_UID` | `prometheus` | Datasource name/UID |
| `BFF_GRAFANA_AUTH_PROXY_*` | | Proxy mode headers |
| `BFF_PLATFORM_SETTINGS_PATH` | empty | JSON overrides when history DB is off |

Admins can override Grafana settings in **Platform → System settings** (PostgreSQL or `BFF_PLATFORM_SETTINGS_PATH`). The console does **not** store Grafana passwords.

## `tenants.toml` source

1. Maintain ConfigMap `opensandbox-tenants` `data.tenants.toml` (see [tenants-configmap.example.yaml](../k8s/tenants-configmap.example.yaml)).
2. Mount the same file on server and BFF pods (`subPath: tenants.toml`).

`TENANTS_TOML_PATH` must point to a **`.toml` file**, not a Kubernetes YAML file.

## Secret structure

See [console-bff-secret.example.yaml](../k8s/console-bff-secret.example.yaml): `BFF_SESSION_SECRET`, `BFF_ADMIN_TOKEN`. Tenant keys live only in mounted `tenants.toml`.

## Credentials separation

| Credential | Storage | Use |
|------------|---------|-----|
| Tenant `api_keys[]` | `tenants.toml` | Developer login; BFF → Lifecycle |
| `BFF_ADMIN_TOKEN` | BFF Secret | Admin BFF login only |

## Local `.env`

Copy [bff/.env.example](../bff/.env.example) to `bff/.env` (gitignored).

## Security checklist

- [ ] Tenant keys not in SPA bundle or `localStorage`
- [ ] RBAC: only server + BFF service accounts read `tenants.toml`
- [ ] Admin token rotation process
- [ ] Ingress TLS; `BFF_COOKIE_SECURE=true`
- [ ] Rate-limit or restrict admin login exposure
