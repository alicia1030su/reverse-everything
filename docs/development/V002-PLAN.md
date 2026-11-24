# v0.0.2 实施计划

## 需求锁定

用户已给出完整 S1–S6 规格，并明确授权开发、PR、正常合并和 v0.0.2 正式发布；无需逐阶段再确认。以下为执行假设，不改变用户要求：

- Electron 作为 Windows 桌面候选，先做可运行原型与实测；Tauri 仅在本机 Rust 不可用时记录未验证，不静默安装系统工具。
- `/api` 保持兼容；新增 `/api/v1` 通过 Fastify rewriteUrl 别名到同一路由。
- 无签名证书时发布未签名安装包并明确 SmartScreen 风险。
- 缓存默认项目隔离；跨项目共享必须显式批准。
- 远程 MCP 默认关闭，仅回环；远程监听必须显式配置和非空令牌。
- 服务端 TGZ 需要 Node 22；Windows EXE 内置 Electron Node，不要求用户安装 Node。
- 任何未实测平台/能力不得标为已交付，不得以缩减 P0 的方式发布。

## 架构边界

- contracts：APP_VERSION、统一 Schema、错误码、阶段/证据模型。
- workflow：数据库迁移、缓存、保留、资源、任务预算；不依赖 Fastify/UI。
- core：Adapter 与子进程注册、取消信号。
- api：传输、认证、限速、OpenAPI、SSE、维护操作。
- cli/mcp/desktop/web：同一 API 的适配层，不复制业务逻辑。

## Phase 执行与出口

| Phase | 实施 | 出口证据 |
|---|---|---|
| 0 | 只读审计、基线测试 | V002-BASELINE.md；23+2 测试通过 |
| 1 | 版本、错误、Schema、v1 别名 | 契约测试、旧 API 回归 |
| 2 | schema_migrations、备份、保留、dry-run | v0.0.1 真实结构升级/中断/缺文件测试 |
| 3 | 内容寻址缓存、LRU、损坏回退、统计 | 命中/失效/隔离/竞争测试 |
| 4 | 进程树指标、预算、三级熔断 | 压力/危险/检查点/子进程清理测试 |
| 5 | REST 新端点、OpenAPI、限速 | API 契约与安全回归 |
| 6 | CLI 完整化、npm TGZ、server TGZ | Windows/Linux 干净安装与启动 |
| 7 | MCP SDK、stdio + Streamable HTTP、扩展工具 | 真实 MCP 客户端握手与调用 |
| 8 | Agent Skills 标准包、脚本、ZIP | 规范校验与安全演示 |
| 9 | Electron 桌面、Sidecar、NSIS/便携包 | Windows CI 安装/启动/退出冒烟 |
| 10 | Web 系统/资源/缓存/保留/开发者/诊断页面 | E2E 真实指标与操作 |
| 11 | 六入口一致性、性能、安全、Docker | 汇总报告，无伪造数据 |
| 12 | PR、保护规则合并、Tag、Release | 资产安装复验、SHA-256、正式 Release |

## 验证策略

- 每个内核 Phase 先写失败测试，再实现，再跑相关回归。
- 新测试覆盖正常、空、损坏、并发、超限、旧数据、缺文件、未授权。
- 构建按包顺序，默认单 Worker/单浏览器；不同时跑多套 E2E。
- CI 拆分 quality、package、mcp、skill、windows-desktop、docker、release。
- 发布前 PRR：可观测、可靠/回滚、容量、安全、数据、流程全部有证据。

## 回滚与恢复

- 数据库迁移前 `VACUUM INTO` 备份；事务内应用，失败回滚并保留备份。
- 应用回滚到 v0.0.1 前停止新版本 Worker，恢复迁移前备份；新表不影响旧版读取。
- 缓存可整体禁用或清空，不删除原始上传/正式证据。
- EXE 更新使用用户数据目录，安装器不覆盖 `%APPDATA%` 数据。
- Release/Tag 不移动、不强推；失败修复后新提交/新构建，不覆盖已发布资产。
