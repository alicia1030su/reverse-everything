# REST API（v0.0.4）

- 基础地址：`http://127.0.0.1:4173/api/v1`
- 兼容地址：`/api`，两者路由相同
- 认证：`Authorization: Bearer <local-token>`；Web 使用 HttpOnly、SameSite=Strict cookie
- OpenAPI：`GET /api/openapi.json`，规范版本 **0.0.4**；可运行 `npm run openapi` 生成 `docs/api/openapi-v0.0.4.json`
- 错误：`{error:{code,message,requestId,details?}}`
- 列表：支持 `limit` / `offset`；项目/任务保留数组响应并提供 `x-total-count`

默认仅回环。远程监听必须显式设置 `RE_ALLOW_REMOTE=true` 与 `RE_ALLOWED_HOSTS`；硬件枚举和桌面指标上传在远程模式下仍被拒绝。

## 系统与能力

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 公开最小健康检查、产品版本与 schema |
| GET | `/api/version` | 产品、API、证据与安全策略版本 |
| GET | `/api/capabilities` | adapter 与入口能力 |
| GET | `/api/system/status` | API、Worker、浏览器、MCP 与 adapter 状态 |
| GET | `/api/resources` | API/Worker/Desktop 当前资源快照 |
| GET | `/api/resources/history` | 分页资源采样历史 |
| POST | `/api/resources/desktop` | Electron 桌面指标；仅本机回环 |

## 项目、任务与证据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects` | 项目列表/创建；创建需 `authorizationConfirmed=true` |
| GET/DELETE | `/api/projects/:id` | 项目详情/精确名称确认删除 |
| POST | `/api/projects/:id/uploads` | 流式上传并计算 SHA-256 |
| POST | `/api/projects/:id/tasks` | 创建任务，可传资源预算 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 阶段、证据、发现、日志、产物与报告 |
| POST | `/api/tasks/:id/:action` | `pause` / `resume` / `cancel` / `retry` |
| GET | `/api/tasks/:id/events` | SSE，支持 `Last-Event-ID` |
| GET | `/api/tasks/:id/events/history` | 持久化事件历史 |
| GET | `/api/tasks/:id/evidence` | 分页证据 |
| GET | `/api/evidence/search` | 跨项目/任务证据搜索 |
| GET | `/api/evidence/:id` | 证据详情 |
| GET | `/api/tasks/:id/artifact-manifest` | 产物哈希与下载路径 |
| GET | `/api/tasks/:id/artifacts/:name` | 下载产物 |
| GET | `/api/tasks/:id/report` | 下载 Markdown 报告 |

项目 kind：`website`、`software`、`game`、`security`、`protocol`、`hardware`、`firmware`。任务 adapter：`website`、`file`、`security`、`game`、`network`、`apk`、`ghidra`、`hardware`、`firmware`。

Android 使用 `software` + `apk`；开发板复用 `hardware`，固件镜像使用 `firmware`，不存在 `board` adapter。

## 硬件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/hardware/capabilities` | 平台能力、限制与枚举状态 |
| GET | `/api/hardware/doctor` | 设备数量、异常与截断状态 |
| GET | `/api/hardware/devices` | OS 可见 USB 身份、拓扑与描述符；序列号脱敏 |
| GET | `/api/hardware/serial` | 串口列表；`opened=false`、`liveCapture=false` |

全部为只读枚举，仅本机回环可用。接口不打开设备、不改变 DTR/RTS、不启动捕获。离线 USB/HID 分析通过项目上传与 `hardware` 任务执行。

## 缓存、维护与备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cache` | 分页缓存条目 |
| GET | `/api/cache/stats` | 命中、miss、损坏、淘汰与大小 |
| POST | `/api/cache/clear` | 显式清理；需 `confirm=CLEAR_CACHE`，默认 dry-run |
| GET | `/api/cache/verify` | 校验缓存 payload 哈希 |
| GET/PUT | `/api/retention` | 读取/更新保留策略 |
| GET | `/api/maintenance/preview` | 清理 dry-run |
| POST | `/api/maintenance/apply` | 应用清理；需 `confirm=CLEAN` |
| GET | `/api/maintenance/events` | 清理审计事件 |
| GET/POST | `/api/backups` | 备份列表/创建 |
| GET | `/api/backups/:id/verify` | 摘要、schema、SQLite 完整性校验 |
| GET | `/api/backups/:id/events` | 备份生命周期事件 |
| POST | `/api/backups/:id/preview` | 隔离恢复预览 |
| POST | `/api/backups/:id/restore` | 隔离恢复；需 `confirm=RESTORE_BACKUP` |

保留策略不自动删除原始上传或正式任务产物。活动任务的临时文件与日志受保护；删除项目需精确项目名且不能有活动任务。

## 设置与演示

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/settings` | 脱敏 AI 设置与加密密钥写入 |
| POST | `/api/settings/test` | 测试 OpenAI 兼容端点 |
| GET | `/api/demo/trace` | 下载项目自编写游戏的回放记录 |

远程模型必须使用 HTTPS 并显式允许数据共享。模型输出为 `INFERENCE`，不能替代工具证据。
