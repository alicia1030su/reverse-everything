# v0.0.4 缺陷登记

状态：Phase 0 审计基线；下表保留初始缺陷与验收口径。当前修复结果以 V004-TEST-RESULTS.md、V004-FINAL-REPORT.md 和最终独立复审为准，不以初始“待修复”列作为当前状态。P0/P1 必须修复并留“修复前失败→修复后通过”回归；P2 在不影响安全与旧功能时处理。

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
| V004-019 | Worker lease | P1 | 租约过期且无接管者时，catch 的 mutateOwned 失败，finally 按 owner 清 lease 但保留 RUNNING；recover 跳过 NULL lease | 失败终态与 claim 释放不原子 | 失租终态/可恢复租约，禁止 RUNNING+NULL lease | 无接管者过期恢复、Worker 重启、统计/删除 | 待修复 |
| V004-020 | Cache hot path | P1 | 命中后 `engine.ts:167` 仍 put，重复 JSON/hash/temp/事务/rename 并刷新 TTL | 未区分本次 hit 与 historical hit | 命中不重写 payload；访问元数据与绝对 TTL 策略明确 | writes/mtime/expires_at 与大 payload 热路径基准 | 待修复 |
| V004-021 | Retention | P1 | PUT 只存 JSON；API/Worker 不应用新 cache/resource/artifact/disk 预算 | 策略无运行时刷新契约，两个字段未接入 | 热更新或明确重启；所有字段接入实际预算 | 热更新后超预算写入/采样/工件拒绝 | 待修复 |
| V004-022 | Evidence | P2 | `db.evidence(id)` 默认 1000 条；去重/报告/导出看不到更早证据 | 展示分页上限用于完整性操作 | SQL 条件去重，完整导出或明确截断 | 1001 条证据重复第 1 条 ID 复用 | 待修复 |
| V004-023 | Retention race | P2 | apply 的 active 快照在文件 await 后过期，retry 后历史 logs/events 仍可被删 | 删除前未重新检查任务状态 | 每条 DB 删除前事务内 freshness/fencing | rm gate 期间 retry，活跃指标保留 | 待修复 |
| V004-024 | Queue admission | P2 | queued 计数与 insert 之间有 await，单 API 不同项目并发也可超 RE_MAX_QUEUE | admission 非原子 | DB 事务内计数+插入或全局 admission 锁 | maxQueue=1 并发创建仅一个 201 | 待修复 |
| V004-025 | Worker status | P2 | Worker 退出后旧 snapshot 无 TTL，system/status 永久 available | stored 无 staleness | sampledAt TTL/stale 状态 | 假时钟过期后 available=false/stale=true | 待修复 |
| V004-026 | Benchmark | P2 | cacheHit 用累计 hits；E2E peakApiRssMB 受 5s snapshot TTL 影响 | 指标口径错误 | 逐任务 hit delta、fresh/独立高频采样 | 历史 hit 本次 miss；短内存尖峰 | 待修复 |
| V004-027 | macOS resources | P1 | `resources.ts:73` 接受 minutes=60/seconds=60，CPU 时间被累加 | 仅验证部分字段，未验证时间分量范围 | 严格 0-59 和有限 cpuSeconds，畸形行 fail-closed | `00:60:60` 等 exact Red/Green | 待修复 |
| V004-028 | Multi-instance | P1 | Database 无独占 guard；双 API 同 dataDir 时删除快照后另一实例可创建任务并留下目录 | 仅进程内项目锁 | 可靠 API 实例独占或跨进程 DB 项目 mutation fencing | 双 buildServer 同库删除/创建确定性交错 | 待修复 |
| V004-029 | Export | P1 | `engine.ts:240-241` 报告/导出使用 db.evidence 默认1000条 | 展示分页用于完整性操作 | 专用完整导出或明确截断并校验 | >1000 证据报告/manifest/evidence.json 一致 | 待修复 |
| V004-030 | Android parser | P1 | ZIP 无 CRC32、DEX 无 checksum/SHA-1、重开路径无 whole-file identity、local/central 名称不校验、MUTF-8 截断、AXML 长度洞、validate 恒真 | 只解析结构未验证完整性 | 修复解析与恒真断言；JADX 使用不可变输入副本 | exact 损坏/替换/截断 Red/Green；真实 JADX smoke | 待修复 |
| V004-031 | Ghidra CI | P1 | `ghidra-v004.yml` 只监听不存在的 `tools/v004/**` | 触发路径与真实改动不一致 | 覆盖 adapter/launcher/verify/fixture/tests 路径 | PR 真实 Ghidra job 触发并产出 artifacts | 待修复 |
| V004-032 | Ghidra packaging | P1 | Windows adapter 依赖 release-root launcher，但 Server TGZ 未包含 | 打包资源清单不完整 | package-server 包含 ghidra launcher | 打包布局与真实 CI 可用性 | 待修复 |
| V004-033 | Ghidra bounds | P1 | 262144 截断后追加 marker 实际到 262155 | 上限按截断前长度计算 | Java/TS 按最终字节硬上限 | exact 溢出边界测试 | 待修复 |
| V004-034 | Ghidra metadata/redaction | P2 | decompileFailureCount 仅钳制无关系校验；先截断后脱敏；Windows available 检查不足 | 边界与完整性/脱敏顺序问题 | 关系不变量、先脱敏后截断、launcher/jar/Java 检查、导出类型 | 单测与真实工具复核 | 待修复 |
| V004-035 | Ghidra evidence | P2 | verify-ghidra 硬编码 12.2；JAVA_HOME 与 LaunchSupport 实际 Java 可能不同；外部安装无 archiveVerified | 工具证据字段不准确 | 读 application.properties、记录实际 Java、archiveVerified | CI JSON 证据字段核对 | 待修复 |
| V004-036 | Android JADX artifacts | P0 | 嵌套 artifact 名经生产 safeArtifactName 扁平化，同名文件覆盖且 manifest 引用失效 | 测试 ctx 绕过生产命名 | 唯一安全扁平名，记录实际名，真实 WorkflowEngine 导出回归 | 同名 R.java/BuildConfig.java 与清单共存、hash 一致 | 待修复 |
| V004-037 | Android availability | P1 | available 每次 spawn Java，状态轮询高频启动未监控进程 | 无 TTL/静态检查 | TTL 单飞或静态检查 | capabilities/status 调用不重复 spawn | 待修复 |
| V004-038 | Android provenance | P1 | expectedSha256 被当作工具 provenance；RE_JADX_BIN 可任意 wrapper | 未计算实际 hash/verificationMode | 实际工具 hash、wrapper/verified 模式 | 篡改/外部安装负向测试 | 待修复 |
| V004-039 | Android input identity | P1 | JADX 读可变 upload，metadata hash 与反编译输入不绑定 | 无不可变副本 | 私有副本+前后 identity/hash | 替换 upload exact 回归 | 待修复 |
| V004-040 | Android budgets | P1 | 内置 DEX 可跳过，但 JADX 仍处理整个 APK | 元数据与反编译预算不统一 | 反编译输入 DEX 数量/字节限额或拒绝 | 超预算 BLOCKED/不启动 JADX | 待修复 |
| V004-041 | Android artifact hash | P1 | files/manifest 记录 redact 前 JADX bytes hash/size | raw/artifact 混用 | raw 与 artifact 两套尺寸哈希 | 生产下载 digest 与 manifest 一致 | 待修复 |
| V004-042 | Android CI | P1 | 真实 JADX 仅 dispatch，real test 默认 skip | PR/push 不触发 | 真实 known-answer 进入发布门禁 | CI Run ID 与日志 artifact | 待修复 |
| V004-043 | Android redaction | P1 | 窄规则漏 JWT/private key/Cookie/AWS key | 敏感模式覆盖不足 | 扩展脱敏与负向样本 | Java/resources 全产物面 | 待修复 |
| V004-044 | Android validation | P1 | limitations.length>=0 恒真；不校验 files/count/artifacts | 恒真门禁 | 真实关系/完整性断言 | 缺文件/损坏 manifest FAILED | 待修复 |

## 完成定义

- 所有 P0/P1 修复，或有明确不可自主解决的外部限制；不得用删除旧功能或降低断言获得绿色。
- 每个代码修复保留失败回归和通过证据。
- 硬件物理设备未实测时，相关能力标记 BLOCKED/UNVERIFIED，不影响离线分析和只读枚举的正式交付。
- 独立复审锁定实际哈希；代码变化后旧结论失效。
