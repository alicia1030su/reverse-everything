# 逆向万物 v0.0.1 技术架构

## 1. 选型决策

- **本地单用户、模块化单体**：Web 静态资源与 Fastify API 同端口，SQLite + 独立 Worker 进程。避免微服务、消息集群和 Kubernetes。
- **TypeScript 为主**：React/Vite/Fastify/Node LTS；Python/Ghidra 仅在未来原生 provider 中加入。
- **Node 内置 SQLite**：Node 22.13+ `node:sqlite`，避免本机编译 better-sqlite3。
- **npm workspaces**：本机无 pnpm，不把包管理器差异作为阻塞。
- **默认 AI 关闭**：OpenAI 兼容端点可选；规则分析不依赖模型。

## 2. 组件

```text
Browser / CLI / MCP
        │ HTTP + local token / SSE
        ▼
Fastify API ────── SQLite (projects/tasks/stages/evidence/findings/logs/events/artifacts/settings)
        │ enqueue                          ▲
        ▼                                  │ persisted stage output
Independent Worker ── Adapter Registry ────┘
        │
        ├── website: Playwright + pinned DNS + same-origin route
        ├── file: bounded static parser + yauzl + SBOM
        ├── security: safeFetch passive headers + static rules
        └── game: trace inference → generated WebSocket service → E2E
```

API 不执行分析任务；Worker 默认并发 1。`scripts/start.mjs` 同时启动两个进程并转发退出信号。Docker Compose 使用同一入口。

## 3. 包结构

- `packages/contracts`：共享类型、状态机、阶段常量。
- `packages/evidence`：SHA-256、规范 JSON、产物写入。
- `packages/security`：SSRF/DNS 校验、固定 IP fetch、ZIP 安全、秘密加密/脱敏。
- `packages/ai`：token 估算、预算与脱敏工具。
- `packages/workflow`：SQLite 仓储、队列、阶段执行、报告/SARIF。
- `packages/core`：统一 Adapter 与四个实现。
- `apps/api`：REST、认证、上传、SSE、设置、静态站点。
- `apps/worker`：独立分析进程。
- `apps/cli`：CLI 与 stdio MCP server。
- `apps/web`：React 控制台。

## 4. 持久化模型

| 表 | 关键字段 |
|---|---|
| projects | id, name, kind, target, authorization_confirmed, created_at |
| uploads | project_id, stored_name, mime, size, sha256 |
| tasks | adapter, status, current_stage, progress, attempt, input_hash, options_json, flags |
| stages | task_id, name, status, attempt, timestamps, error, cache_key, output_json |
| evidence | kind, title, source, locator, content_json, sha256 |
| findings | category, severity, confidence, evidence_ids, details, recommendation, status |
| logs | level, message, tool, created_at |
| events | autoincrement id, task_id, type, payload_json |
| artifacts | name, stored_path, size, sha256, mime |
| settings | AI 端点/模型/开关/加密密钥 |

上传文件位于 `data/uploads/<projectId>/<random>`；产物位于 `data/tasks/<taskId>/artifacts/`。用户提供的文件名只作为元数据，不直接作为路径。

## 5. 任务执行与恢复

1. API 创建 QUEUED 任务和全部 PENDING 阶段。
2. Worker 轮询一条 QUEUED 任务，设置 RUNNING。
3. 每阶段开始写 RUNNING，结束写 SUCCEEDED/FAILED 与 output_json。
4. 阶段间重新读取任务标志，响应 pause/cancel。
5. 重启时 RUNNING → QUEUED，当前 RUNNING 阶段 → PENDING；加载所有已成功阶段输出。
6. 重试只重置当前失败阶段，attempt +1；之前阶段输出保留。
7. REPORT 生成 Markdown 和 SARIF；EXPORT 生成 manifest/evidence 清单。
8. COMPLETED 阶段与任务状态最终提交。

默认阶段预算 300 秒；Playwright 单页导航 45 秒、截图 15 秒；HTTP 20 秒；模型 60 秒。超时保留检查点，不静默成功。

## 6. Adapter 契约

```ts
detect(ctx) → format/confidence/details/limitations
prepare(ctx) → validated inputs and execution boundaries
analyze(ctx) → tool observations
extractEvidence(ctx) → persisted evidence/findings/artifacts
reconstruct(ctx) → generated independent implementation or UNKNOWN
validate(ctx) → reproducible checks and limitations
```

插件异常使当前阶段 FAILED，不让 API 崩溃。外部依赖不可用时返回明确 detail。v0.0.1 的注册表是编译时数组；动态第三方插件加载不在本版本开放。

## 7. API 契约

- `GET /api/health`、`GET /api/session`
- `GET/POST /api/projects`、`GET/DELETE /api/projects/:id`
- `POST /api/projects/:id/uploads`
- `POST /api/projects/:id/tasks`、`GET /api/tasks`、`GET /api/tasks/:id`
- `POST /api/tasks/:id/:action`（pause/resume/cancel/retry）
- `GET /api/tasks/:id/events`（SSE）
- `GET /api/tasks/:id/report`、`GET /api/tasks/:id/artifacts/:name`
- `GET/PUT /api/settings`、`POST /api/settings/test`
- `GET /api/stats`、`GET /api/adapters`、`GET /api/demo/trace`

所有业务 API 需要本地令牌；Web 通过 HttpOnly SameSite=Strict cookie，CLI/MCP 读取 `data/local-token`。仅接受 loopback Host 与同源 Origin。

## 8. 安全边界

- URL 仅 HTTP/HTTPS；默认拒绝 loopback、私网、link-local、metadata、保留地址、公网非标准端口。
- HTTP 每次重定向重新验证；请求 DNS 结果固定到已验证 IP，降低重绑定风险。
- Playwright 使用 host-resolver-rules 固定主机，并拒绝跨源子资源。
- 外部文本永远不作为系统指令；AI prompt 明确声明目标内容不可信。
- 不上传目标到第三方模型；远程模型需显式同意。
- API Key AES-256-GCM 加密，密钥文件权限 0600，接口不返回明文。
- 归档只读中央目录，限制条目数、总展开大小和压缩比。

## 9. 资源策略

- 默认一个 Worker、一个队列任务；不同时启动多个重型浏览器。
- 文件/字符串/JSON/DOM/网络记录均有上限；归档不解压。
- 浏览器禁用 GPU/dev-shm，使用 1440×1000 视口，不抓取跨源资源。
- 构建按包顺序执行；开发只启动 API + Worker，不默认再开 Vite。
- 内存目标不是承诺：API <350MB、轻量任务 <1GB 需在目标平台实测；见 TEST-RESULTS。

## 10. ADR 摘要

1. **单体而非微服务**：单用户本地工具，运维成本优先。
2. **独立 Worker 而非 API 内执行**：保护 API 响应与资源预算。
3. **SQLite 而非 PostgreSQL**：零外部服务，WAL 与事务足够。
4. **固定 DNS + 同源浏览器**：兼顾真实采集与 SSRF 边界。
5. **规则兼容服务而非伪造原始恢复**：只生成可验证的独立实现。
6. **Monaco 本地拆包**：代码查看器不依赖 CDN。
7. **无 AI 也可用**：模型是增强，不是事实来源或核心分析前提。
