# 逆向万物 v0.0.4 技术架构

## 1. 选型决策

- **本地单用户、模块化单体**：Web 静态资源与 Fastify API 同端口，SQLite + 独立 Worker。
- **TypeScript 为主**：React/Vite/Fastify/Node LTS；Ghidra/JADX 作为用户合法安装的外部工具按需调用。
- **Node 内置 SQLite**：Node.js 22.13+ `node:sqlite`，WAL、事务迁移与 runtime lease。
- **npm workspaces**：共享 contracts，统一版本源 `VERSION`。
- **默认 AI 关闭**：OpenAI 兼容端点可选；规则分析不依赖模型。
- **证据优先**：实现状态不等于证据等级；外部工具输出必须可定位、可哈希。

## 2. 组件

```text
Browser / CLI / MCP / Skill
        │ HTTP + local token / SSE
        ▼
Fastify API ────── SQLite (projects/tasks/stages/evidence/findings/logs/events/artifacts/settings)
        │ enqueue                          ▲
        ▼                                  │ persisted stage output
Independent Worker ── Adapter Registry ────┘
        │
        ├── website: Playwright + pinned DNS + same-origin route
        ├── file/security/game/network: bounded static/offline/replay analysis
        ├── apk/ghidra: Android metadata + optional real external tools
        ├── hardware: read-only enumeration + offline USB/HID parsers
        └── firmware: bounded streaming static analysis
```

API 不执行重型分析；Worker 默认并发 1。`scripts/start.mjs` 同时启动两个进程并转发退出信号。Docker Compose 使用同一入口。

## 3. 包结构

- `packages/contracts`：版本、状态机、项目/任务/证据/资源/保留契约。
- `packages/evidence`：SHA-256、规范 JSON、安全工件读取与私有快照。
- `packages/security`：SSRF/DNS 校验、固定 IP fetch、ZIP 安全、秘密加密/脱敏。
- `packages/ai`：token 估算、预算与脱敏工具。
- `packages/workflow`：SQLite 仓储、队列、阶段执行、缓存、资源、保留、报告/SARIF。
- `packages/hardware`：Windows/Linux 只读枚举、USB PCAP/PCAPNG/usbmon、HID 与热插拔身份。
- `packages/firmware`：BIN/IMG、HEX、UF2、ELF、布局、熵、字符串、组件与 SBOM 线索。
- `packages/core`：统一 Adapter 与九个实现。
- `apps/api`：REST、认证、上传、SSE、硬件、桌面指标、静态站点。
- `apps/worker`：独立分析进程。
- `apps/cli`：CLI、stdio MCP 与 Streamable HTTP MCP。
- `apps/desktop`：Electron 壳、sidecar 与真实桌面指标。
- `apps/web`：React 控制台。

## 4. 入口、项目 kind 与 adapter

| 用户入口 | 项目 kind | adapter |
|---|---|---|
| website | `website` | `website` |
| software | `software` | `file` |
| android | `software` | `apk` |
| game | `game` | `game` |
| network | `protocol` | `network` |
| security | `security` | `security` |
| usb | `hardware` | `hardware` |
| firmware | `firmware` | `firmware` |
| board | `hardware` | `hardware` |

第七类入口 id 为 `usb`，项目 kind/adapter 为 `hardware`；第九类 `board` 仅复用 `hardware`，不调用 `firmware`，不宣称特定品牌/型号或实时设备支持。Ghidra 是 `software` 卡片内高级选项，使用独立 `ghidra` adapter。Web 卡片、CLI 项目 kind 与 API adapter 必须保持上述映射；不得为 UI 名称虚构后端能力。

## 5. 持久化模型

| 表 | 关键字段 |
|---|---|
| projects | id, name, kind, target, authorization_confirmed, created_at |
| uploads | project_id, stored_name, mime, size, sha256 |
| tasks | adapter, status, current_stage, progress, attempt, input_hash, options_json, flags |
| stages | task_id, name, status, attempt, timestamps, error, cache_key, output_json |
| evidence | kind, title, source, locator, content_json, sha256 |
| findings | category, severity, confidence, evidence_ids, details, recommendation, status |
| logs/events | 阶段日志与持久化事件序号 |
| artifacts | name, stored_path, size, sha256, mime |
| settings/cache/resource_samples/backups | 加密设置、缓存、指标、备份与审计 |

上传位于 `data/uploads/<projectId>/<random>`；产物位于 `data/tasks/<taskId>/artifacts/`。用户文件名只作为元数据，不直接作为路径。当前 schema 为 3。

## 6. 任务执行与恢复

1. API 创建 QUEUED 任务和全部 PENDING 阶段。
2. Worker 轮询任务，设置 RUNNING，并写阶段输出。
3. 阶段间读取 pause/cancel 标志；重型阶段有超时与资源预算。
4. 重启时恢复未完成阶段；成功阶段在同一任务重试时复用。
5. REPORT 生成 Markdown 和 SARIF；EXPORT 生成 manifest/证据清单。
6. 任务状态最终持久化；超时、工具缺失与取消不静默成功。

默认阶段预算 300 秒；具体上限由 adapter 与任务 options 共同约束。Ghidra/JADX 使用有界外部进程，不运行目标程序。

## 7. Adapter 契约

```ts
detect(ctx) → format/confidence/details/limitations
prepare(ctx) → validated inputs and execution boundaries
analyze(ctx) → tool observations
extractEvidence(ctx) → persisted evidence/findings/artifacts
reconstruct(ctx) → generated independent implementation or UNKNOWN
validate(ctx) → reproducible checks and limitations
```

注册表为编译时数组。插件异常使当前阶段 FAILED；外部依赖不可用时返回真实 detail，不创建假任务。

## 8. 外部工具与证据状态

- Ghidra：headless 进程、隔离项目、函数/伪代码/调用图/字符串引用代码已实现；真实 Ghidra/JDK 已知答案 CI 未完成前为 `PARTIAL` / `BLOCKED`。
- JADX：APK 反编译进程链与产物代码已实现；真实 WorkflowEngine/CI 与已知答案证据未完成前为 `PARTIAL` / `BLOCKED`。
- 本地 fake headless、故障注入与替身测试不能标为真实工具 `VERIFIED`。
- 工具版本、实际可执行文件、输入副本与产物哈希必须进入证据/manifest。

## 9. API、MCP 与 Skill

- REST：`/api/v1` 与 `/api` 同路由；运行时 OpenAPI 版本 0.0.4。
- 认证：本地 Bearer token 或 HttpOnly SameSite=Strict cookie；Host/Origin 校验。
- MCP：stdio 与 Streamable HTTP 共用 API，注册 21 个工具；不暴露破坏性维护或设备执行能力。
- CLI：命令由 `apps/cli/src/cli.ts` 单一解析器提供；文档以 `--help` 为准。
- Skill：环境检查与工作流封装，不拥有独立业务逻辑。

## 10. 缓存、资源与保留

- 缓存仅覆盖 `CLASSIFY`、`PREPARE`、可复用 `ANALYZE`；实时 adapter 不缓存 ANALYZE。
- 默认项目 scope；global scope 需显式批准。键包含 policy、输入、adapter/阶段/工具版本与脱敏 options。
- 缓存读取验证 payload SHA-256；损坏按 miss 处理并按容量/TTL/引用计数淘汰。
- 资源监控采样 API/Worker 进程树、系统内存、磁盘、队列与压力，并使用 TTL、迟滞和失败分类。
- 桌面指标合并 Electron `app.getAppMetrics()` 与 sidecar 快照；缺失、陈旧、截断写入 `limitations`。
- 保留先 preview 再 apply；活动任务临时文件/日志受保护；原始上传与正式产物不自动删除。

## 11. 安全边界

- URL 仅 HTTP/HTTPS；默认拒绝 loopback、私网、link-local、metadata、保留地址与公网非标准端口。
- HTTP 每次重定向重新验证并固定 DNS；Playwright 使用 host-resolver-rules 与同源限制。
- 外部内容是数据，不是系统指令；模型输出为 `INFERENCE`。
- API Key AES-256-GCM 加密；日志、缓存与证据脱敏。
- 工件读取核验普通文件、身份、大小与哈希；Windows 私有快照使用 ACL 并拒绝 reparse point。
- API runtime lease 与 Electron 单实例锁防止并发写同一数据目录。
- 硬件只读枚举仅本机回环；不打开设备、不实时捕获、不刷写。
- 固件与 USB/HID 输入有界解析；原始 payload、凭证与键盘报告不进入证据。

完整边界见 [安全模型](SECURITY-MODEL.md)。

## 12. ADR 摘要

1. **单体而非微服务**：单用户本地工具，运维成本优先。
2. **独立 Worker**：保护 API 响应与资源预算。
3. **SQLite**：零外部服务，WAL、事务与租约足够。
4. **固定 DNS + 同源浏览器**：兼顾真实采集与 SSRF 边界。
5. **独立兼容服务而非伪造原始恢复**：只生成可验证实现。
6. **九类入口共享 adapter 契约**：UI 名称不扩大执行权限。
7. **实现与验收分离**：真实外部工具、物理设备与 CI 证据决定 `VERIFIED`。
