# v0.0.2 Phase 0 基线审计

审计时间：2026-11-24 UTC+8。性质：只读审计 + 基线测试；未修改业务代码，未清理任何用户或历史测试数据。

## 1. Git 与发行基线

- 工作区：干净，分支 `main`。
- 本地 HEAD：`4c7a46f71248515fdade72f28d473f06327442fd`。
- `origin/main`：同一 SHA；GitHub API 再次确认。
- Tag：`v0.0.1`，annotated tag object `bb8df0359f2d9e06d1df29058eb4c0c71416b5e6`，指向上述提交。
- Release：<https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.1>，`draft=false`、`prerelease=false`。
- 分支：仅 `main`；无 v0.0.2 分支、提交或 PR。
- 最近 CI：v0.0.1 Release run `45220042440` 成功；main CI run `45219400431` 成功。
- 历史失败 run 已定位并修复：Worker 漏编、Playwright 缓存路径、容器 CLI 调用；不得重复提交这些修复。

## 2. 环境与资源

- Windows 11 x64；Node `v22.22.2`；npm 10.9.7；Git 2.56.1；GitHub CLI 2.105.0。
- 可用物理内存约 19.97GB / 总 33.01GB。
- Chrome 已安装（E2E 使用系统 Chrome）；Playwright Chromium 也可由 CI 安装。
- Docker、pnpm、Python、Rust/Cargo 不在 PATH；不默认可用，不静默安装系统工具。
- 本机数据目录已有历史 token、密钥、SQLite 和测试遗留目录；本次只读，不输出秘密值，不删除未经确认的数据。

## 3. 现有包与依赖

npm workspaces：`apps/*`、`packages/*`，lockfile 为 `package-lock.json`。

| 包 | 版本 | 运行依赖 |
|---|---|---|
| @reverse/api | 0.0.1 | Fastify、multipart、static、contracts/core/workflow/ai |
| @reverse/worker | 0.0.1 | core/security/workflow |
| @reverse/cli | 0.0.1 | contracts；bin 为 `reverse`、`reverse-mcp` |
| @reverse/web | 0.0.1 | React 18、Vite 6、TanStack Query、React Flow、Monaco |
| @reverse/core | 0.0.1 | contracts/evidence/security/workflow、Playwright、ws |
| @reverse/workflow | 0.0.1 | contracts/evidence |
| @reverse/security | 0.0.1 | yauzl |
| @reverse/ai / evidence / contracts | 0.0.1 | 无外部运行依赖 |

生产依赖 119 个，许可证检查通过；`npm audit --omit=dev` 为 0 漏洞。

## 4. 现有能力矩阵

| 能力 | v0.0.1 实际状态 |
|---|---|
| Web 控制台 | 已有 9 个主要页面，深色响应式，真实 API |
| API | Fastify `/api`，本地 token + Host/Origin 校验，SSE |
| 任务系统 | SQLite 项目/任务/阶段/证据/发现/日志/事件/产物 |
| Worker | 独立 Node 进程，并发 1，阶段检查点恢复 |
| 网页 | Playwright 同源 DOM/脚本/路由/截图/NDJSON |
| 文件 | PE/ELF/Mach-O 基础元数据、字符串、ZIP、SBOM |
| 安全 | 被动 HTTP 与静态规则，SARIF |
| AI | OpenAI 兼容配置、加密密钥、INFERENCE |
| 游戏 | 真实回放推断、独立兼容服务、L3 E2E |
| CLI | 基础项目/任务/报告命令；非独立安装包 |
| MCP | 手写 stdio JSON-RPC，8 个工具；无 HTTP |
| Skill | 只有文档，无标准技能包 |
| 桌面 | 无 |
| Docker | Compose 构建/健康/Web/CLI 已在 CI 通过 |
| 缓存 | 仅同任务阶段输出复用；无跨任务缓存 |
| 迁移 | 无 `user_version`、无 schema_migrations、无备份迁移 |
| 保留 | 无分类保留、dry-run 或自动清理 |
| 资源 | API/Worker Node 自报 RSS；无进程树、CPU、磁盘、句柄、浏览器子进程 |
| 熔断 | 仅 Worker 自身 RSS 超阈值停止取新任务；无三级状态/安全检查点 |
| API 产品化 | 无 OpenAPI、稳定错误码、分页、限速、v1 别名 |
| 发行 | 仅 GitHub 源码归档；无 EXE/TGZ/Skill ZIP/SBOM/OpenAPI 资产 |

## 5. 数据与迁移机制

- 数据库文件：`data/reverse-everything.sqlite`，WAL、foreign_keys、busy_timeout。
- 构造函数内联 `CREATE TABLE IF NOT EXISTS`，无版本号。
- 旧库直接打开不会丢表，但新版本无法可靠识别结构、备份或回滚。
- 上传：`data/uploads/<projectId>/<random>`；产物：`data/tasks/<taskId>/artifacts`。
- 加密设置存 SQLite `settings`，密钥文件与数据库同目录；迁移必须保留二者。
- 当前删除项目直接删目录和数据库行，无保留审计。

## 6. CLI / MCP / API 契约

- CLI 直接调用 `/api`，从 `RE_DATA_DIR/local-token` 读取令牌。
- MCP 当前自行实现 JSON-RPC，协议版本声明 `2025-06-18`，8 个工具与 CLI 共用 API。
- API 返回体不统一；错误多为 `{error:string}`，无错误码/requestId/分页。
- 路由无 `/api/v1`；不得破坏旧 `/api` 客户端。
- Task/Project/Evidence ID、状态和证据 Schema 已在 contracts 定义，可作为统一契约基础。

## 7. Web 与 Worker 生命周期

- API 提供静态 Web，开发不额外启动 Vite。
- `scripts/start.mjs` 启动 API + Worker，转发退出信号。
- Worker 启动 recover，把 RUNNING 重置为 QUEUED；单任务执行；关闭等待当前任务。
- 暂停/取消仅在阶段边界响应；重型浏览器阶段最长约 45 秒。
- 日志写 SQLite，单任务查询最多 1000 条；无日志轮转。

## 8. 测试与 CI 基线

实际复跑：

- `npm run typecheck`：通过。
- `npm run lint`：通过，0 warnings。
- `npm test`：5 文件、23 项全部通过。
- `npm run test:e2e`：2 项全部通过。
- `npm audit --omit=dev`：0 vulnerabilities。
- CI：Windows + Ubuntu + Docker Compose 全绿。

## 9. 主要风险与实施顺序

1. **P0 数据升级**：先加 schema 版本、备份、事务迁移和 v0.0.1 真实结构测试。
2. **P0 统一契约**：先集中版本/错误/Schema，所有新入口复用，不重写旧业务。
3. **P0 缓存**：只缓存纯阶段输出，按项目隔离；原子写入、哈希校验、LRU、统计。
4. **P0 资源**：进程树采样、队列/磁盘/时间预算、三级熔断、安全 checkpoint。
5. **P0 API**：v1 rewrite 别名、OpenAPI、证据/缓存/保留/资源端点、限速。
6. **P0 CLI/TGZ**：先让 CLI 脱离源码，再构建 npm TGZ 与 server TGZ。
7. **P0 MCP/Skill**：使用官方 SDK/规范，保留 8 个旧工具，新增只读工具。
8. **P0 EXE**：Electron 路线做真实原型；Tauri 需要 Rust，本机不具备，不假装完成原型对比。
9. **P0 Web/CI/Release**：新页面、六入口一致性、Windows 安装冒烟、产物哈希后发布。

## 10. 审计结论

v0.0.1 基线可用且可复现。v0.0.2 不应推倒重来；应在现有 contracts/workflow/core 上增加迁移、缓存、资源、平台入口和发行层。最高风险是“新增入口各自实现业务”，因此统一 API 与状态机是所有发行方式的前置条件。
