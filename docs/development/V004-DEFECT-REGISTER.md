# v0.0.4 缺陷登记

状态：Phase 0 审计完成，修复尚未开始。P0/P1 必须修复并留“修复前失败→修复后通过”回归；P2 在不影响安全与旧功能时处理。

| ID | 模块 | 等级 | 复现 / 证据 | 根因 | 修复方向 | 回归 / 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| V004-001 | Workflow | P1 | `engine.ts:117-129,251-259` 在 SQLite 写事务内同步分块 SHA-256 | 为关闭 TOCTOU 将完整哈希放入 immediate 事务 | 私有暂存+流式/Worker 预校验+不可变对象+事务内短身份/fencing | 1MB/10MB/100MB/500MB/1GB 条件基准；API/SSE/cancel/lease/event-loop；篡改/symlink/cancel/crash 回归 | 待修复 |
| V004-002 | Resources | P1 | `resources.ts:212-216` 所有采样异常降为同一 limitation；`engine.ts:66,144` 直接熔断/中止 | 指标不可用、超限、过期、进程退出未分类 | 分类错误、有限重试、TTL/staleness、安全降级；真实超限仍 fail-closed | Windows 子进程失败、Linux 瞬时退出、macOS、PID 重用、高负载、Chromium 退出 | 待修复 |
| V004-003 | Ghidra | P1 | `ghidra.ts:220,225` 明确不导出伪代码/调用图 | 仅 metadata postScript | 增加有界 decompile/callgraph/string references；Windows launcher | 官方 Ghidra+JDK CI，对自建 PE/ELF 已知函数对照 | 待修复 |
| V004-004 | Android | P1 | `apk.ts:206` 明确无反编译 | 仅 ZIP/AXML/DEX 表 | 按需 JADX 或等效真实工具，资源/smali/方法体输出 | 自建 APK 已知类/方法/资源对照；超时/磁盘/取消 | 待修复 |
| V004-005 | AI | P1 | `engine.ts:203-205` planner steps 只写 evidence | 协议层规划未连接到执行 | 实现白名单阶段计划的安全执行或收窄承诺 | 恶意 prompt、越权工具、预算、无进展、真实模型可选验收 | 待修复 |
| V004-006 | Release | P1 | `release-v003.yml:363` 直接 `gh release create --latest` | 先公开后上传，存在不完整窗口 | Draft→上传→逐项 digest→一次性 publish；拒绝覆盖正式 Release | workflow 静态测试、幂等重跑、公开地址复验 | 待修复 |
| V004-007 | Test harness | P2 | `platform.test.ts:19` 清理 85 项被宿主保护拦截，8 项测试已通过 | 单个 recursive rm 触发批量删除阈值 | 已知临时根内分批清理，每批校验；不绕过安全保护 | 本地全量 suite 退出码 0 | 待修复 |
| V004-008 | Desktop | P1 | API 读取 `stored('desktop')`，全仓库无 `sample('desktop')` | 指标生产端缺失 | 桌面 sidecar 采样完整 API/Worker/renderer/Electron 进程树 | 真实桌面任务峰值与退出后孤儿进程检查 | 待修复 |
| V004-009 | API/UI | P2 | `server.ts:93` detail 一次加载全部 evidence/report；Projects 无新增任务入口 | 展示模型直接加载全量 | 分页/按需读取，已有项目新建任务 | 大任务 API 延迟与 Web E2E | 待修复 |
| V004-010 | Web | P2 | `NewProject.tsx:45` security 强制文件；Layout 无移动导航；Dashboard labels 缺 adapter | 入口模型与 adapter 契约漂移 | 九类入口、移动抽屉、完整 labels、项目/运维入口 | Web E2E 与界面检查 | 待修复 |
| V004-011 | File safety | P1 | `evidence.ts:59` 仅 POSIX mode 0600；Windows symlink 用例跳过 | 平台文件身份/ACL 覆盖不足 | Windows Junction/Reparse/硬链接/替换专项，私有快照 ACL | Windows CI 专用测试；POSIX 不回归 | 待审计 |
| V004-012 | Docs | P2 | README 和不存在的 CLI 命令；多份文档停留在 v0.0.1/v0.0.2 | 文档未随版本和能力更新 | 中英文 README、用户指南、链接/命令/能力一致性测试 | Markdown/links/clean-env commands | 待修复 |
| V004-013 | Versioning | P2 | 根版本、workspaces、lock、contracts、compose、Web、workflow 多处复制 | 无真正单一同步源 | VERSION 文件/同步脚本与一致性测试 | 干净 bump 演练、diff 检查 | 待修复 |
| V004-014 | Capability | P1 | 无 USB/固件/HID/serial 任何实现 | v0.0.3 未交付硬件模块 | 新增 hardware/firmware 包和统一 adapter/API/CLI/MCP/Skill/Web | 模拟+官方离线样本+只读系统枚举；物理设备限制单独记录 | 待实现 |
| V004-015 | Multi-instance | P2 | 项目锁为进程内 Map；共享 dataDir 的多 API 行为未在用户文档明确 | 锁边界与部署契约不一致 | 核实 DB runtime guard，支持单实例或数据库级保护 | 双 API 实例竞态测试/明确拒绝 | 待审计 |
| V004-016 | Workflow state | P1 | `engine.ts:247` 对 PAUSED 只设 cancel_requested；resume 后 QUEUED 仍被 `claimNext` 排除 | 取消语义未覆盖 PAUSED | PAUSED+cancel 直接 CANCELLED，或 resume 后可靠兑现取消 | API/CLI/MCP/Web 状态回归，长期不卡 QUEUED | 待修复 |
| V004-017 | Project deletion | P1 | `server.ts:89` 只删目录/项目行；cache_entries 与 events.task_id 无项目级级联 | 删除语义不完整，缓存 payload 与事件残留 | 项目删除清理项目缓存、事件和对象，保护共享缓存；事务/文件一致 | 项目缓存/事件/文件删除回归与隐私文档 | 待修复 |
| V004-018 | Cache evidence | P1 | `engine.ts:163` CLASSIFY 命中缓存跳过 `runStage`，新任务缺 Detected 证据 | 缓存只保存 output，不重建任务级证据 | 命中时重建任务级 evidence 或显式复用证据引用 | 同项目同输入两任务证据/报告一致性 | 待修复 |

## 完成定义

- 所有 P0/P1 修复，或有明确不可自主解决的外部限制；不得用删除旧功能或降低断言获得绿色。
- 每个代码修复保留失败回归和通过证据。
- 硬件物理设备未实测时，相关能力标记 BLOCKED/UNVERIFIED，不影响离线分析和只读枚举的正式交付。
- 独立复审锁定实际哈希；代码变化后旧结论失效。
