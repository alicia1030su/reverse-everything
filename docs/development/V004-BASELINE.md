# v0.0.4 真实基线

审计时间：2026-11-25 UTC+8。审计阶段只读，未修改产品源码。

## Git 与发行

- 远端仓库：`alicia1030su/reverse-everything`。
- 远端 `main`：`d09b496fe968e30c6f16df623a752165fa554bfd`。
- 本地审计分支：`fix/v003-sensitive-field-limit`，HEAD `624cdf470a6b104b7b89efb4fbc11d1882d302df`。
- 本地 HEAD 与远端 main 文件树一致；Git SHA 不同是 v0.0.3 网络故障时通过 GitHub Git Data API 创建等价提交所致。
- `v0.0.3` 为 annotated Tag，tag object `7f60c358a8d413daf7f39b0e9951b163497bae8a`，解引用 Commit 为 `d09b496…`。
- v0.0.3 Release 为非草稿、非预发布，12 个资产全部 uploaded。
- v0.0.3 候选 run `45526180496` 成功；Tag 后自动 `release.yml` run `45532023769` 失败且无 job 明细，需要在 v0.0.4 废弃旧自动发布路径。
- 开放 Issue：0；开放 PR：0。
- 根版本与 contracts：`0.0.3`；Schema：3；Evidence/Security/Cache policy：`3.0.0`。

## 本地实测基线

| 检查 | 结果 | 证据 / 限制 |
|---|---|---|
| `npm run typecheck` | 通过 | 退出码 0 |
| `npm run lint` | 通过 | 退出码 0 |
| `npm test` | 343 passed / 3 skipped；1 个 suite 清理失败 | 30 文件中 29 文件直接通过；`platform.test.ts` 8 项全过后，清理 85 项临时文件被 WorkBuddy `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 拦截 |
| 单独 `platform.test.ts` | 8 passed；同一清理失败 | 复现与全量运行一致，不是产品断言失败 |
| Electron E2E | v0.0.3 报告 5/5 | 本轮尚未重跑，标记为历史证据 |
| 历史性能 | 冷 P95 132.18ms，热 P95 173.35ms，热命中 100%，峰值 RSS 143.36MB | 仅参考；本轮需同硬件、同输入重新归因 |

3 个跳过项均为 Windows 无法创建 symlink 的平台用例。v0.0.4 必须补 Junction/Reparse Point/文件替换专项，不能继续只依赖 Unix symlink。

## 架构现状

- npm workspaces：6 个 package（contracts/evidence/security/ai/workflow/core）、5 个 app（api/worker/cli/desktop/web）。
- React/Vite Web；Electron 加载同一 Web；Fastify API；独立 Node Worker；SQLite WAL。
- 编译时 adapter registry，当前 7 个：website/file/security/game/network/apk/ghidra。
- 统一阶段：INTAKE→CLASSIFY→AUTHORIZATION_CHECK→PLAN→PREPARE→ANALYZE→COLLECT_EVIDENCE→MODEL_BEHAVIOR→RECONSTRUCT→VALIDATE→REPORT→EXPORT→COMPLETED。
- 证据分类：EVIDENCE / INFERENCE / UNKNOWN / VERIFIED。
- API 项目删除、上传、任务创建和任务动作使用进程内 `projectMutations` Map（`apps/api/src/server.ts:69-70`）。Database 运行时单实例约束需在修复阶段核实并明确文档化。
- PAUSED 任务 cancel 只设置 flag，resume 后仍被 claimNext 排除，可能永久卡住（`engine.ts:51,246-247`）。
- 项目删除未清理 cache payload 与 events；缓存命中 CLASSIFY 不重建任务级 Detected 证据（`server.ts:89`、`engine.ts:163,196`）。
- 工件发布在 `BEGIN IMMEDIATE` 内调用同步 `verifyArtifactObjectSync`，包含同步分块 SHA-256（`packages/workflow/src/engine.ts:117-129,251-259`）。这是本轮明确 P1。
- 资源采样失败时 `performSample` 返回带 limitation 的 fallback；Worker admission 和运行中采样 catch 会直接阻断/中止任务（`engine.ts:65-68,144`；`resources.ts:212-216`）。需区分指标不可用与真实超限。

## 已确认的历史能力边界

- Ghidra：真实 `analyzeHeadless` 进程链、隔离项目、函数/字符串元数据已实现；无伪代码、调用图、字符串引用关系。Windows `.bat/.cmd` 直接执行路径不完整。
- Android：APK 安全 ZIP、AXML、DEX string/type/proto/method/class 表元数据已实现；无 JADX 或等效反编译、资源解码、smali 输出。
- 网页：多页面、同源拦截、状态转移、DOM/截图/网络证据和独立静态兼容预览已实现；不是动态网站或原后端克隆。
- 游戏：独立状态化 L4 兼容服务，非原始服务端恢复；v0.0.3 安全修复和真实 child process 验证必须保留。
- AI：Planner/Interpreter/Validator 协议和有界重试已实现；planner 的 steps 仅作为证据，不驱动 adapter 执行。无真实 Key 时不得把 fake model 验收为真实 AI。
- 硬件：仓库无 USB/HID/serial/firmware/device-contracts/hardware-agent 实现、依赖或测试。
- 桌面：`resources.stored('desktop')` 被 API 读取，但全仓库无 `sample('desktop')` 调用；桌面完整进程树指标实际缺失。

## 发行与文档缺口

- `release-v003.yml` 的 publish 使用 `gh release create ... --latest`，资产随命令上传，不是 Draft→完整校验→一次性公开。
- `release.yml` 与 `release-v002.yml` 仍硬编码 0.0.2、`draft:false`，可被 dispatch，必须禁用或加严格版本门禁。
- README 仍以 v0.0.1 为主，包含不存在的 `tasks create` / `tasks report` 命令；CLI-MCP/CLI/UPGRADE/KNOWN-ISSUES/ARCHITECTURE 多份文档过时。
- Web 安全分析入口错误强制文件；移动端无导航；项目与运维入口不完整；Dashboard 对 network/apk/ghidra 显示 undefined。
- CLI 缺 `tasks create`、protocol 项目创建和多数 adapter 的分析命令；MCP 17 工具不含硬件能力；Skill 仅声明式工作流。
- 无品牌图片或真实产品截图；Electron 无 icon 配置。

## 审计原则

- Mock/fake 只证明控制流与故障处理，不证明外部工具或物理设备能力。
- 代码路径存在不等于能力 VERIFIED。
- 复审冲突以可重复的 exact 运行证据为准。
- 不删除旧功能、不放宽测试断言、不伪造设备/模型/性能数据。
