# Console sandbox image build — build context storage (OSS + PG)

## Goal

Support **sandbox image build** in the developer console: users assemble a **Docker build context** (Dockerfile + files), optionally download a **tar** locally (Phase 1), and later **save drafts** or **submit build jobs** (Phase 2). Large blobs live in **object storage (OSS/S3-compatible)**; **PostgreSQL** holds metadata, manifests, and links to `console_sandbox_image_catalog`.

This spec is **console/BFF scope only**. Remote build execution (cluster builder, lifecycle image push) is a separate integration; BFF stores context and job state until a build API exists.

## Phases

| Phase | User capability | Storage |
| --- | --- | --- |
| **1** | Tree + editor + upload; validate paths; **tar download** in browser or via BFF | No PG/OSS required |
| **2a** | **Save draft** per tenant/user; resume editing | PG row + OSS objects |
| **2b** | **Submit build**; poll logs/status; on success link **image_uri** to catalog | PG job row + OSS tar snapshot + optional builder pull URL |

Phase 1 must not block on OSS/PG env. Phase 2 requires the same history DB pool pattern as `console_sandbox_image_catalog` (`BFF_HISTORY_DATABASE_URL` / existing `init_history_pool`).

## Build context model (API JSON)

Logical document stored in PG as JSONB (`manifest`) and mirrored on disk in OSS as individual objects plus one **context tar** for builders.

```json
{
  "version": 1,
  "dockerfile": "Dockerfile",
  "files": {
    "Dockerfile": { "encoding": "utf-8", "sha256": "…" },
    "scripts/bootstrap.sh": { "encoding": "utf-8", "sha256": "…", "size": 1234 }
  }
}
```

Rules:

- All paths are **relative**, POSIX-style, no `..`, no absolute paths, no leading `/`.
- **Dockerfile** must exist; default name `Dockerfile` at context root unless `dockerfile` field points to another relative path.
- Max file count, max total uncompressed size, and max single file size are BFF config (defaults TBD in implementation).
- Binary files use `encoding: "base64"` in API uploads; OSS stores raw bytes. Text uses UTF-8 on OSS.

## OSS layout

Reuse the **same OSS credential pattern** as node-agent log archive (`BFF_NODEAGENT_OSS_*`) **or** dedicated keys (recommended to avoid mixing with `logs/` prefix):

| Env (proposed) | Purpose |
| --- | --- |
| `BFF_IMAGE_BUILD_OSS_ENDPOINT` | S3-compatible endpoint |
| `BFF_IMAGE_BUILD_OSS_BUCKET` | Bucket name |
| `BFF_IMAGE_BUILD_OSS_KEY_PREFIX` | Default `console/image-build` |
| `BFF_IMAGE_BUILD_OSS_ACCESS_KEY_ID` | Read/write for BFF |
| `BFF_IMAGE_BUILD_OSS_ACCESS_KEY_SECRET` | |

If dedicated vars are empty, implementation **may** fall back to node-agent OSS settings with a **different prefix** (document in BFF config docs).

### Key naming

Tenant-scoped keys prevent cross-tenant reads. Use URL-safe segments; no user-controlled raw path segments without normalization.

```text
{prefix}/v1/tenant/{tenant_id}/context/{context_id}/files/{path_sha256_prefix}/{safe_path}
{prefix}/v1/tenant/{tenant_id}/context/{context_id}/context.tar.gz
{prefix}/v1/tenant/{tenant_id}/job/{job_id}/context.tar.gz
```

- `context_id`, `job_id`: UUID strings (match PG `id`).
- `safe_path`: relative path with `/` preserved; URL-encode or hash suffix if path contains unusual characters (implementation: store **canonical relative path** in PG manifest; OSS key uses SHA256 of normalized path as directory shard to avoid huge key names).

Optional lifecycle: delete OSS prefix when context/job row is hard-deleted; soft-delete keeps objects for retention window.

### Object metadata (OSS user meta)

- `x-oss-meta-sha256`: hex digest of object body (verify on read).
- `x-oss-meta-tenant-id`: duplicate for audit.
- `Content-Type`: `application/gzip` for tar; `text/plain` or `application/octet-stream` for files.

## PostgreSQL schema

Tables live in the **console history database** (same pool as `sandbox_lifecycle_history` and `console_sandbox_image_catalog`). Migrations: `CREATE TABLE IF NOT EXISTS` in `console/bff/app/history/store.py` (extended-scope branch) or a future Alembic if upstream adopts one.

### `console_sandbox_build_context`

Draft or immutable snapshot of a build context.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TEXT PK` | UUID |
| `tenant_id` | `TEXT NOT NULL` | From session / admin `?tenant=` |
| `display_name` | `TEXT NOT NULL` | User label |
| `status` | `TEXT NOT NULL` | `draft` \| `ready` \| `archived` |
| `manifest` | `JSONB NOT NULL` | Build context model (paths → sha256, sizes, encodings) |
| `dockerfile_path` | `TEXT NOT NULL DEFAULT 'Dockerfile'` | Redundant for query; must match manifest |
| `tar_oss_key` | `TEXT` | Set when tar uploaded; nullable for draft-only file uploads |
| `tar_sha256` | `TEXT` | Hex; nullable until tar built |
| `tar_size_bytes` | `BIGINT` | Nullable |
| `created_by` | `TEXT NOT NULL DEFAULT ''` | Console user id or email |
| `updated_by` | `TEXT NOT NULL DEFAULT ''` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |

Indexes:

- `(tenant_id, updated_at DESC)` — list drafts for tenant.
- `(tenant_id, status)` — filter.

### `console_sandbox_build_job`

Build submission and outcome (Phase 2b).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TEXT PK` | UUID |
| `tenant_id` | `TEXT NOT NULL` | |
| `context_id` | `TEXT NOT NULL` | FK → `console_sandbox_build_context.id` |
| `status` | `TEXT NOT NULL` | `queued` \| `running` \| `succeeded` \| `failed` \| `cancelled` |
| `builder_ref` | `TEXT` | Opaque id from remote build service |
| `context_tar_oss_key` | `TEXT NOT NULL` | Snapshot at submit time |
| `context_tar_sha256` | `TEXT NOT NULL` | |
| `image_uri` | `TEXT` | Populated on success; unique per catalog |
| `catalog_image_id` | `TEXT` | FK → `console_sandbox_image_catalog.id` when registered |
| `log_oss_prefix` | `TEXT` | Optional streamed logs in OSS |
| `error_message` | `TEXT` | Failure summary |
| `submitted_by` | `TEXT NOT NULL DEFAULT ''` | |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `finished_at` | `TIMESTAMPTZ` | |

Indexes:

- `(tenant_id, created_at DESC)`.
- `(context_id)`.
- `(status)` where status in active states (optional partial index).

**Catalog link:** On `succeeded`, BFF (or admin workflow) inserts/updates `console_sandbox_image_catalog` with `image_uri`, then sets `catalog_image_id` on the job row.

## BFF API sketch (Phase 2)

All routes require authenticated console session; tenant scope from session or admin query param.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/images/build-contexts` | List contexts for tenant |
| `POST` | `/api/images/build-contexts` | Create draft (manifest may be minimal) |
| `GET` | `/api/images/build-contexts/{id}` | Metadata + manifest (not inline large file bodies) |
| `PATCH` | `/api/images/build-contexts/{id}` | Update manifest metadata / display_name |
| `PUT` | `/api/images/build-contexts/{id}/files/{path}` | Upload one file → OSS + update manifest |
| `DELETE` | `/api/images/build-contexts/{id}/files/{path}` | Remove file from manifest + delete OSS object |
| `POST` | `/api/images/build-contexts/{id}/tar` | Assemble tar, upload to OSS, set `tar_*` columns |
| `GET` | `/api/images/build-contexts/{id}/tar` | Presigned URL or streaming download |
| `POST` | `/api/images/build-jobs` | Body `{ "contextId": "…" }` → snapshot tar, enqueue builder |
| `GET` | `/api/images/build-jobs/{id}` | Status + log pointers |

Phase 1 may expose only:

- `POST /api/images/build-context/tar` — stateless: body = manifest + inline file contents → **stream tar** (no PG/OSS).

## Security

- Enforce **tenant_id** on every PG query and OSS key prefix; admin routes must require explicit `tenant`.
- Presigned URLs: short TTL; optional IP restriction if OSS provider supports it.
- Do not expose OSS credentials to the browser; uploads go through BFF.
- Validate path traversal and zip-slip if accepting tar uploads later.

## Config summary (BFF)

Document alongside `console/docs/02-bff-config-and-secrets.md` when implemented:

- `BFF_IMAGE_BUILD_OSS_*` (see above).
- `BFF_IMAGE_BUILD_MAX_FILES`, `BFF_IMAGE_BUILD_MAX_TOTAL_BYTES`, `BFF_IMAGE_BUILD_MAX_FILE_BYTES`.
- `BFF_IMAGE_BUILD_ENABLED` — gate Phase 2 APIs (default false until OSS+PG ready).

## Out of scope (this spec)

- Changing lifecycle server or OpenAPI for image build.
- Builder implementation (Kaniko, BuildKit job, etc.).
- MVP upstream console PR stack: Phase 1 tar-only can ship without PG/OSS; extended-scope branch carries schema + Phase 2.

## Test plan (when implementing)

- Unit: path normalization, manifest validation, tar layout matches Docker context expectations.
- Integration (mock OSS): upload file → manifest sha256 → tar endpoint → digest matches PG row.
- Tenant isolation: context `id` from tenant A must not be readable under tenant B session.
