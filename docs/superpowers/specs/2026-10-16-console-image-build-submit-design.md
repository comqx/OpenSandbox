# 控制台沙箱镜像制作：提交远程构建并实时看日志

## 目标

在现有「沙箱镜像制作」页上接通外部打镜像服务：用户提交当前草稿的未压缩构建上下文，页面立刻拿到 `taskId`，并持续显示构建日志，直到最后一条结果。

构建服务在后台构建。成功后镜像留在对应架构的 Docker 里，不推送仓库。日志结果为 `success` 时，BFF 把本次 `imageName` 写入 `console_sandbox_image_catalog`，使它出现在沙箱镜像列表。同一镜像地址已存在则保持原记录。

## 和存储规格的关系

[2026-10-13 构建上下文存储规格](./2026-10-13-console-sandbox-image-build-context-storage.md) 的 Phase 1 和 Phase 2a 已经落地：编辑、本地下载未压缩 tar、草稿进 PostgreSQL 和 OSS。

该规格 Phase 2b 里的 `context.tar.gz` 不采用。实际构建服务只接受未压缩 tar，根目录文件名必须是 `Dockerfile`，并且不推仓库。成功后写入镜像目录：显示名用草稿名（最长 80 字符），镜像地址用提交的 tag。任务标识用构建服务返回的 `taskId`，不另造一套排队状态。

## 构建服务契约

服务根地址由部署填入，本仓库默认形态是 `http://<host>:8000`。这两个接口没有鉴权。

### 提交

`POST {base}/api/v1/build-image`

`Content-Type: multipart/form-data`

| 字段 | 说明 |
| --- | --- |
| `file` | 未压缩 tar。根目录必须有名为 `Dockerfile` 的文件。不接受 `.tar.gz`。上限 2GB |
| `imageName` | 镜像 tag。最长 255。只允许字母、数字和 `._:/-`。不能有空格，不能含 `..` |
| `basicStruct` | `1` = amd64，`2` = arm64 |

成功时 HTTP 200，`data.status` 固定为 `building`，并返回 `data.taskId`。HTTP 200 只表示任务已开始。

失败时 HTTP 400 或 500，body 为 `{ "code": 10103 或 10101, "message": "..." }`。`10103` 是参数错误，`10101` 是服务端错误。

### 日志

`GET {base}/api/v1/build-image/{taskId}/logs`

`Content-Type: text/event-stream`。除 `taskId` 为空外，这个接口一直是 HTTP 200。

过程日志：

```text
event: log
data: {"line":"Step 1/3 : FROM alpine:3.20"}

```

构建结束后，最后一条没有 `event`，`data` 是结果：

```text
data: {"status":"success","imageName":"...","message":""}

```

`status` 只有 `success`、`failed`、`cleaned`。`cleaned` 表示构建进程里已经没有这次任务（服务重启或日志已不在内存），`imageName` 为空字符串，`message` 固定为 `构建日志已清理`。

同一个 `taskId` 可以反复请求。后连上的客户端会先收到已有日志，最后一条仍是结果。客户端断开不会取消构建。

## 选定方案

浏览器只访问控制台 BFF。BFF 校验登录会话和租户，用 OSS 上的草稿文件打未压缩 tar，再调用构建服务。`taskId` 写入 PostgreSQL。日志由 BFF 按字节转发 SSE。

不采用另外两种做法：

- 浏览器直接调用构建服务。构建服务没有鉴权，也不能暴露到控制台公网；`EventSource` 也无法带上额外的鉴权头。
- 浏览器把 tar 再上传一遍给 BFF。草稿文件已经在 OSS，BFF 侧打包与现有「下载 tar」使用同一份内容。

BFF 不在后台单独守着日志流。构建服务自己会重放日志。页面每次打开日志都会重新请求，BFF 在那次转发里看到最终结果后更新数据库。

## 架构

```text
浏览器（SameSite=Lax 会话 Cookie，同源 /api）
  POST /api/images/build-contexts/{id}/builds
  GET  /api/images/build-contexts/{id}/builds/{taskId}/logs
        |
        v
Console BFF
  校验会话与租户
  从 OSS 文件打未压缩 tar
  校验 Dockerfile 与 imageName
  multipart 提交构建服务
  写入 console_sandbox_build_job
  转发 text/event-stream，并在看到最终结果时更新 job
        |
        v
构建服务（集群内，无鉴权，不进 Ingress）
  POST /api/v1/build-image
  GET  /api/v1/build-image/{taskId}/logs
```

构建服务使用 ClusterIP。公网入口只到控制台。

## 数据

草稿表 `console_sandbox_build_context` 的 `status` 仍只表示草稿本身：`draft` 或 `ready`。构建状态单独放在 job 表，避免一次构建改写草稿是否已打包。

在 `console/bff/app/history/store.py` 的现有建表流程里增加：

```sql
CREATE TABLE IF NOT EXISTS console_sandbox_build_job (
    task_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    image_name TEXT NOT NULL,
    basic_struct TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    tar_sha256 TEXT NOT NULL DEFAULT '',
    submitted_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_console_sandbox_build_job_context_created
    ON console_sandbox_build_job (context_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_console_sandbox_build_job_active
    ON console_sandbox_build_job (context_id)
    WHERE status = 'building';
```

`task_id` 使用构建服务返回的 32 位十六进制，作为主键。`status` 只使用 `building`、`success`、`failed`、`cleaned`。`basic_struct` 存 `"1"` 或 `"2"`。

部分唯一索引保证同一个草稿同时只有一条 `building`。两条请求同时提交时，后插入的一条撞上索引，接口返回 409。

不保存构建日志正文。日志只存在于构建进程内存；页面需要时再向构建服务拉取。

上下文列表和详情增加 `latestBuild`。没有 job 时为 `null`。取值是该 `context_id` 下 `created_at` 最新的一条：

```json
{
  "taskId": "32位十六进制",
  "imageName": "hub.example.com/ns/app:1.0",
  "basicStruct": "1",
  "status": "building",
  "message": "",
  "createdAt": "2026-10-16T01:00:00+00:00",
  "finishedAt": null
}
```

## BFF 接口

沿用构建上下文路由的会话和租户规则。租户用户使用会话里的租户；管理员必须带 `?tenant=`。job 的读写都带 `tenant_id`，别的租户的 `taskId` 返回 404。

未配置 `BFF_IMAGE_BUILDER_BASE_URL`，或镜像制作开关、历史库、OSS 未就绪时，提交返回 503，`code` 为 `IMAGE_BUILDER_NOT_CONFIGURED`，`message` 为 `构建服务未配置`。

### 提交构建

`POST /api/images/build-contexts/{contextId}/builds?tenant=`

```json
{ "imageName": "hub.example.com/ns/app:1.0", "basicStruct": "1" }
```

`basicStruct` 只接受字符串 `"1"` 或 `"2"`。

处理顺序：

1. 确认草稿属于当前租户。
2. 若该草稿已有 `status=building` 的 job，返回 409，`code` 为 `IMAGE_BUILD_IN_PROGRESS`，`message` 为 `已有构建进行中`。不访问构建服务。
3. 校验 `imageName`：去掉首尾空白后长度 1 到 255，匹配 `^[A-Za-z0-9._:/-]+$`，且不包含 `..`。提交给构建服务和写入 job 的都是去掉空白后的值。空字符串返回 `镜像名称不能为空`；其余不合法返回 `镜像名称不合法`。
4. 校验架构。不是 `"1"` 或 `"2"` 时返回 `架构类型只支持 1(amd64) 或 2(arm64)`。
5. 校验 Dockerfile。`dockerfile_path` 必须正好是 `Dockerfile`，且 manifest 里有这个文件。否则返回 `tar 包根目录缺少 Dockerfile`。不改写 tar 内的文件名。
6. 用现有 OSS 文件打未压缩 tar（`tarfile` mode `w`），写回 OSS，并让草稿 `status=ready`。打包结果超过 2GB 时返回 `tar 包超过大小限制（2GB）`，不提交。
7. 用这份 tar 字节调用构建服务。表单字段名为 `file`、`imageName`、`basicStruct`。
8. 构建服务 HTTP 200 且 `data.taskId` 为 32 位十六进制时，插入 job，`status=building`，`message` 为空。响应：

```json
{
  "taskId": "32位十六进制",
  "contextId": "草稿 id",
  "imageName": "hub.example.com/ns/app:1.0",
  "basicStruct": "1",
  "status": "building"
}
```

9. 构建服务返回 400/500 时不插入 job。`10103` 映射为 HTTP 400，`10101` 映射为 HTTP 502。`message` 原样放到 BFF 的 `detail.message`。网络失败、超时、或 200 但没有合法 `taskId`，返回 502，`message` 为 `构建服务不可达` 或 `构建服务返回异常`。

上述参数错误的 HTTP 状态为 400，`detail.code` 为 `IMAGE_BUILD_INVALID`。BFF 自己的错误形状仍是 `{ "detail": { "code", "message" } }`，与现有构建上下文接口一致。

提交前，页面前端必须先把编辑器里的文件同步到 OSS。BFF 不接收浏览器里的 tar，只打包 OSS 上已有的文件。

提交请求的超时只覆盖「接受任务」：连接 10 秒，写请求 120 秒，读响应 60 秒。构建本身在构建服务后台进行，不占用这条 HTTP 请求。

### 转发日志

`GET /api/images/build-contexts/{contextId}/builds/{taskId}/logs?tenant=`

仅当 job 属于该租户和该草稿时转发。响应：

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `X-Accel-Buffering: no`

BFF 把上游字节原样写给浏览器。同时按 SSE 事件（以空行分隔）解析：

- 带 `event: log` 的事件不写数据库。
- `data` JSON 含 `status`，且值为 `success`、`failed`、`cleaned` 之一时，仅当 job 当前仍是 `building`，才更新为该状态、写入 `message` 并设置 `finished_at`。
- job 已经离开 `building` 后，后续连接即使重放到另一条结果，也不改数据库。列表上的状态保持第一次终态。抽屉里展示的仍是这一次连接的原始流。

浏览器断开时停止向上游读取。构建继续。下次打开日志会重放；若当时 job 仍是 `building`，BFF 看到最终结果后再更新。页面关掉期间，job 可以一直显示 `building`。

日志上游的读超时不设置上限，连接超时 10 秒。上游连不上时不改 job，由浏览器按断线重连。不另造一条失败结果，避免一次网络抖动把仍在进行的构建记成失败，从而放行下一次提交。

## 页面

改 `console/web/src/pages/SandboxImageBuildPage.tsx`。云端草稿可用、当前文件校验通过、并且 Dockerfile 路径就是 `Dockerfile` 时，「构建镜像」可点。云端未配置时按钮保持停用。

点击「构建镜像」：

- `latestBuild.status` 为 `building` 时，不弹表单，直接打开该 `taskId` 的日志抽屉。按钮文案用「查看日志」。
- 其他情况先调用现有的草稿同步，再弹出表单。表单有镜像地址和架构。架构默认 amd64（`"1"`），可选 arm64（`"2"`）。镜像地址前缀固定为 `hub.glodon.com/glodon-pub/`，用户只填写后缀，例如 `app:1.0`。提交时拼成完整 `imageName`。
- 提交成功后打开日志抽屉。若返回 409，刷新草稿并直接打开已有 `taskId` 的日志，不创建第二次构建。

日志使用同源 `EventSource`。管理员把当前租户放在 query 上。Cookie 会随同源请求发送。

```javascript
const es = new EventSource(
  `/api/images/build-contexts/${contextId}/builds/${taskId}/logs${tenantQuery}`,
);
```

租户用户不带 `tenant`。管理员的 `tenantQuery` 与现有接口相同。

- `onopen` 清空日志区。构建服务每次连接都会从头重放，清空后不会重复堆叠。
- 监听 `log`，把 `data.line` 追加到日志区并滚到底部。
- `onmessage` 收到带 `status` 的结果后关闭 `EventSource`，展示结果，并刷新草稿列表。
- 连接中途断开时保留 `EventSource` 的自动重连。`onopen` 会再次清空并接收重放。

结果展示：

| status | 展示 |
| --- | --- |
| `success` | 构建成功。镜像 tag 已写入沙箱镜像列表。同一地址已在列表中时不重复添加 |
| `failed` | 构建失败，展示 `message` |
| `cleaned` | 展示 `构建日志已清理`。之后可以再次提交 |

草稿列表在名称旁显示最近一次构建状态。用户刷新页面后，若状态仍是 `building`，点「查看日志」即可接上同一次构建。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BFF_IMAGE_BUILDER_BASE_URL` | 空 | 构建服务根地址，不含路径。例如 `http://image-builder:8000`。尾部斜杠去掉后再拼接 |

镜像制作原有开关保持不变：`BFF_IMAGE_BUILD_ENABLED`、历史库和 OSS。构建地址单独配置，避免没有构建服务时草稿编辑不可用。

部署时把该变量写入 `opensandbox-console-bff-config`。控制台 Ingress 对 `/api/images/build-contexts/` 的读超时至少 3600 秒，并且不缓冲 `text/event-stream`。

实现时同步这些文档：

- `console/bff/.env.example`
- `console/docs/02-bff-config-and-secrets.md`
- `console/docs/03-bff-api.md`
- `console/docs/05-feature-matrix.md`：沙箱镜像制作改为已接通远程构建；镜像入库仍未做

## 代码边界

| 单元 | 职责 |
| --- | --- |
| `console/bff/app/build_context/builder_client.py` | 拼接 URL、提交 multipart、打开日志流。不认识租户和数据库 |
| `console/bff/app/build_context/image_name.py` | `imageName` 与 `basicStruct` 校验 |
| `console/bff/app/build_context/service.py` | 编排校验、打包、提交、写 job。打包继续复用现有未压缩 tar 逻辑 |
| `console/bff/app/build_context/store.py` | job 的插入、按租户查询、条件更新最终状态 |
| `console/bff/app/routes/build_contexts.py` | 会话、租户、SSE 响应头 |
| `console/web/src/utils/buildImageLog.ts` | 判断一条 SSE `data` 是过程日志还是最终结果 |
| `SandboxImageBuildPage.tsx` | 表单、日志抽屉、重连时清空 |

日志转发里的 SSE 嗅探只用于更新 job。浏览器收到的字节与构建服务发出的字节一致。

## 测试

BFF，使用假的构建客户端，不访问真实构建服务：

- 合法与非法 `imageName`、`basicStruct`。
- Dockerfile 不在根目录或文件名不是 `Dockerfile` 时拒绝，且不调用构建服务。
- 提交的表单字段为 `file`、`imageName`、`basicStruct`，tar 为未压缩格式，根目录含 `Dockerfile`。
- 构建服务 200 后写入 `building` job，并返回 `taskId`。
- 构建服务 `10103` / `10101` 映射状态码和 `message`，不写 job。
- 已有 `building` job 时返回 409，不调用构建服务。并发插入被部分唯一索引挡住。
- 日志转发保留 `event: log` 与最终 `data`。job 仍是 `building` 时，看到 `success`、`failed`、`cleaned` 后更新。
- job 已经结束后，再次重放不改 `status` 和 `finished_at`。
- 日志上游连接失败时不改 job。
- 其他租户的 `taskId` 返回 404。
- 未配置构建地址时返回 503。

前端单测覆盖 `buildImageLog.ts`：`{"line":"..."}` 是过程日志；带 `status` 的对象是最终结果。

## 不做

- 推送镜像仓库。镜像列表只登记本次 tag，不代表镜像已在仓库中。
- 取消构建。页面关闭、浏览器断开、BFF 重启都不取消构建服务上的任务。
- 构建历史页面。只在草稿上带最近一条 `latestBuild`。
- 按镜像名查询构建服务。`taskId` 只来自我们自己的 job 表。
- 在 BFF 或 OSS 保存日志全文。
- 修改 lifecycle server、OpenAPI 或沙箱创建流程。
