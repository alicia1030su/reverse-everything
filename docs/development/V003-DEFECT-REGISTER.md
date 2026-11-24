# v0.0.3 缺陷登记

状态：本地修复与回归完成，候选发行验收待执行。所有修复必须有“修复前复现 → 根因 → 回归测试 → 修复后通过”证据；外部工具限制单独标注，不冒充已完成验收。

| ID | 模块 | 等级 | 复现 / 证据 | 根因 | 修复方案 | 回归测试 | 状态 |
|---|---|---|---|---|---|---|---|
| V003-001 | Release | P0 | v0.0.2 Tag b052e64 ≠ 资产构建 main 38a781c | 正式 Tag 被提前创建，preflight 直接发布到该 Tag | 冻结 Commit→候选构建→验收→创建 Tag→发布已验收资产 | provenance 契约测试、workflow 静态检查 | 已实现，候选验收待执行 |
| V003-002 | 版本 | P1 | `0.0.2` 存在于 contracts/CLI/MCP/Electron/脚本/OpenAPI | 版本散落 | 单一 VERSION 源 + 构建期同步 | version consistency 测试 | 已修复 |
| V003-003 | Migration | P0 | 仅 Schema 2；无备份中心/恢复预览 | 迁移仅 VACUUM + 事务 DDL | Schema 3、备份清单/哈希、隔离恢复、审计 | 历史结构升级、重复/中断/损坏/锁测试 | 已修复 |
| V003-004 | Migration | P0 | 备份创建失败未进入统一错误分类；损坏 DB 可能被空库替代 | 缺少 opening preflight 与恢复策略 | 保留损坏文件，明确 DATABASE_CORRUPT/MIGRATION_FAILED | 故障注入 | 已修复 |
| V003-005 | Cache | P1 | get 未命中不增加 misses；命中率偏差 | cache_stats.misses 无写入 | 统一 hit/miss/write 统计 | 冷/热缓存测试 | 已修复 |
| V003-006 | Cache | P1 | 并发相同 key 无 single-flight；temp 名可能冲突 | 仅进程内直接 put | 内存 single-flight + 随机 temp + 原子 rename | Promise.all 竞争测试 | 已修复 |
| V003-007 | Cache | P1 | 仅 CLASSIFY/PREPARE/ANALYZE；无 AI/网页快照/验证分类 | 缓存模型未分层 | cache kind + 版本化 key + 网页 URL 不作长期键 | 分类/失效/隐私测试 | 已修复 |
| V003-008 | Resources | P0 | Worker ResourceMonitor 读 env，Engine thresholds 用 DEFAULT | 两套阈值来源 | 统一 thresholds 注入 | 阈值单测 | 已修复 |
| V003-009 | Resources | P1 | pressure/danger 无恢复迟滞，可能来回切换 | 单次阈值判断 | 进入/退出阈值 + 连续采样确认 | 迟滞测试 | 已修复 |
| V003-010 | Resources | P1 | health 每次全进程采样；Windows 高频 PowerShell | 无独立采样节流/缓存 | 采样间隔与后台指标 | 采样次数测试 | 已修复 |
| V003-011 | Desktop | P1 | 仅 health/capabilities smoke | 未执行真实 GUI 任务 | Electron E2E 创建/上传/分析/报告/证据/退出 | 本地真实 BrowserWindow 5/5 E2E；Windows CI 安装/便携验收待候选 | 本地已修复，CI 待验收 |
| V003-012 | Website | P1 | 单页 capture，reconstruct 返回 UNKNOWN | 无多页面/重建实现 | 有界多页面状态采集 + 独立重建项目 + 对比 | 多页面自有站点 E2E | 已修复 |
| V003-013 | Binary | P1 | 无 Ghidra Adapter | 仅外部工具未集成 | 可选 headless provider、函数/调用图/伪代码、磁盘/超时/取消边界 | fake headless 与故障注入 29 项通过；真实 Ghidra/JDK 样本对照受本机环境限制 | 已实现，真实工具验收受限 |
| V003-014 | Android | P1 | APK 仅 ZIP 清单 | 无 Manifest/DEX 解析 | APK/DEX 静态适配器 | 自建/许可 APK 测试 | 已修复 |
| V003-015 | Protocol | P1 | 无 HAR/PCAP/PCAPNG | 仅实时 NDJSON/回放 | 离线记录适配器与脱敏 | 自有记录/畸形输入测试 | 已修复 |
| V003-016 | Game | P1 | L3 固定回放，无状态持久化 | 生成器只回放模板 | 状态化账号/移动/物品/存档/重连 | 保留样本 L4 测试 | 已修复 |
| V003-017 | Security | P1 | 无依赖漏洞/AI 研判/修复复测闭环 | 仅规则候选 | SBOM、根/CLI/Server 最终依赖审计、静态候选、AI INFERENCE、needs_review 状态流转；在线 OSV 未启用，自动改代码按安全边界禁用并记录 UNKNOWN | 正负样本、误报复测、最终包 audit 0 vulnerabilities | 已修复（在线 OSV/自动修复明确禁用） |
| V003-018 | AI | P1 | 仅单次摘要，无执行闭环 | 无 Planner/Validator 循环 | 有界 plan→execute→validate→repair | 迭代上限/无进展/超时测试 | 已修复 |
| V003-019 | API | P1 | OpenAPI 手工脚本与路由可能漂移 | 无契约测试 | 路由清单/Schema 对照测试 | OpenAPI contract test | 已修复 |
| V003-020 | Backup | P1 | 无 CLI/Web 备份恢复 | 仅迁移前隐式备份 | BackupService + API/CLI/页面 | 隔离恢复测试 | 已修复 |
| V003-021 | Evidence | P2 | 无统一搜索/关系 API | 仅 task 维度查询 | 分页搜索、关系节点限制 | 大列表/权限测试 | 已修复 |
| V003-022 | i18n | P2 | 中文硬编码，无英文基础 | 无 i18n 层 | 关键文案资源化 | locale 测试 | 未实施（P2，不阻断） |
| V003-023 | SSRF | P0 | `::ffff:7f00:1`、`::7f00:1` 被判 public | 仅用字符串冒号判断 IPv6 | 规范化 IPv4-mapped/compatible，严格 global unicast | 字面量 + DNS AAAA 变体 | 已修复 |
| V003-024 | AI consent | P0 | 撤销 allowRemoteData 后仍向远端发送；localhost.evil 被误放行 | 同意只在设置写入时校验 | 运行时携带 consent，URL.hostname 精确校验 | 假远端撤销测试 | 已修复 |
| V003-025 | Worker lease | P0 | 双 Worker recover 后并发执行同一任务 | 无原子 claim/租约 | SQLite 原子 claim + owner/lease/heartbeat | 双进程同库测试 | 已修复 |
| V003-026 | Cancel | P1 | 取消运行中浏览器/游戏服务不能立即停止 | flag 仅阶段边界检查 | 活动 AbortController + 适配器子进程清理 | 取消后无子进程/迟到产物 | 已修复 |
| V003-027 | SSE | P1 | 其他任务 200 条事件可饿死本任务 SSE | 先全局限流再过滤 task | SQL 按 task_id 过滤 | 跨任务事件洪水测试 | 已修复 |
| V003-028 | Health | P1 | 匿名 health 泄露路径、进程、队列 | 安全校验前 return | 最小 health；资源指标鉴权 | 匿名/跨源负向测试 | 已修复 |
| V003-029 | Pagination | P1 | recover/delete 复用 200 条分页 | 正确性操作使用展示上限 | 状态/项目专用全量查询 | >200 任务测试 | 已修复 |
| V003-030 | Cookie | P2 | 不安全 Set-Cookie 不告警 | 检查 header 值是否含 Set-Cookie | 解析实际属性 | 不安全 cookie 测试 | 已修复 |

## 完成定义

- P0/P1 全部修复或给出不可自主解决的真实阻塞；不得降低等级规避。
- 每个修复附测试文件与命令输出。
- P2 在安全、不影响 P0/P1 的前提下尽量完成。
- 审查后无新增可复现 P0/P1 才进入发行。
