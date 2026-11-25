# v0.0.3 开发进度

最后更新：2026-11-25 UTC+8

- 修复分支：`fix/v003-sensitive-field-limit`
- 本地分支基点：`dd43ce5`（Portable 资产规范化修复）
- 当前阶段：Phase 0–19 已完成；Phase 20 候选资产验收进行中，Phase 21 正式发布待执行
- 冻结前独立复审：游戏 `game.ts=d576d5ce6d9a6445cb66b04901c7dbe793a53d148c9b2e203349c4f4a9e9a88f`；工作流 `engine.ts=2ab92acda7c2fee58e2a177055a1712fac1a02f00024bcef39f44ccc5eb478b0`；两位独立复审员均确认 P0=0/P1=0

| Phase | 状态 | 证据 |
|---|---|---|
| 0 基线审计 | 已完成 | V003-BASELINE / DEFECT-REGISTER / PLAN；多轮独立只读审计 |
| 1 发行追溯 | 已完成 | 版本单源、candidate/publish 分离、Commit 硬校验、provenance 测试 |
| 2 数据库/备份/恢复 | 已完成 | Schema 3、迁移故障注入、VACUUM INTO、隔离恢复、Windows 回滚 |
| 3 资源/性能 | 已完成 | fail-closed、fresh/rootPids、迟滞、指标保留、1000 采样有界测试 |
| 4 缓存 | 已完成 | 分类、single-flight、跨实例字节预算、引用保护、敏感值脱敏 |
| 5 网页重建 | 已完成 | 多页面状态机、弹窗/代理/DNS 固定、离线沙箱、真实 Chrome 回归 |
| 6 原生/Ghidra | 已完成 | headless 元数据流、进程树取消、磁盘预算；真实 Ghidra/JDK 外部验收受限 |
| 7 Android | 已完成 | APK/ZIP/DEX 表边界、压缩炸弹、路径穿越与尾部声明 |
| 8 HAR/PCAP | 已完成 | HAR/PCAP/PCAPNG 有界解析、20k 包性能、DNS/HTTP 脱敏 |
| 9 游戏 L4 | 已完成 | 状态账号/CAS/重连、envelope、数组凭证、冲突 UNKNOWN、请求凭证验证 |
| 10 安全 V2 | 已完成 | SSRF/IPv6、Header/Cookie/CORS、静态规则、SBOM、AI INFERENCE |
| 11 AI 工作流 | 已完成 | Planner/Interpreter/Validator、agent_runs、无进展停止、安全出站 |
| 12 证据知识库 | 已完成 | 全局检索、项目/任务/类型过滤、分页与 Web E2E |
| 13 Web/桌面 | 已完成 | 新分析器入口、备份中心、真实 Electron BrowserWindow E2E |
| 14 EXE 验收 | 进行中 | Windows ZIP/解包 smoke 已通过；NSIS 本机下载受网络 EOF 阻塞，Windows CI 安装验收待候选 |
| 15 六入口 | 已完成 | Web/API/CLI/MCP stdio/HTTP/Skill/Desktop 共享核心契约测试 |
| 16 REA/Benchmark | 已完成 | 100 任务长稳、冷热缓存基准、SQLite quick_check 与状态一致性 |
| 17 内存优化 | 已完成 | 有界解析、缓存预算、资源熔断、峰值 RSS 与长稳报告 |
| 18 全量/故障测试 | 已完成 | 30 files / 343 passed / 3 platform-skips、E2E 5/5、build/typecheck/lint、秘密/许可证/audit |
| 19 独立审查 | 已完成 | 多轮只读审计；游戏与工作流最终冻结哈希经两位独立复审员实跑/定向复测，P0=0/P1=0 |
| 20 发行资产 | 进行中 | 冻结 Commit 后将执行 Linux/Windows/Docker、CLI/Server/Skill、SHA256SUMS/provenance |
| 21 正式发布 | 待开始 | 候选全部验收后创建 annotated Tag 并发布正式 Release |

## 最终本地门禁

- `npm test`：30 个文件、343 passed / 3 skipped（Windows symlink 用例按平台跳过，Linux 候选 CI 执行）；覆盖游戏嵌套凭证六面脱敏、轮换/旧状态迁移、工作流 fencing/事务/lease/prune、API 删除竞态与快照读取。
- `npm run test:e2e`：5/5 通过，包含真实 Electron BrowserWindow。
- `npm run build`、`npm run typecheck`、`npm run lint`：通过。
- `npm run check:secrets`：222 个文本文件通过。
- `npm run licenses`：122 个包，无非许可清单。
- `npm audit --omit=dev`：根依赖 0 vulnerabilities；最终 CLI、最终 Server 由候选 CI 独立审计。
- `npm run validate:skill`：通过。
- OpenAPI：42 paths，生成结果无漂移。
- 长稳：100/100 完成，缓存命中率 99%，`quick_check=ok`，状态不一致 0。
- 尚未创建正式 Tag；历史 v0.0.1/v0.0.2 Release 未改动。

## 独立清零证据

- 游戏最终冻结：`game.ts=d576d5ce6d9a6445cb66b04901c7dbe793a53d148c9b2e203349c4f4a9e9a88f`。真实生成服务运行时验证 A→move→logout→B→move→restart→B、无 logout 第二凭证拒绝、旧 credential-specific `state.json` key 迁移、嵌套子容器 12 类 original/canonical 编码别名六面脱敏、80 元素合法凭证数组（727 指纹，上限 8192）。
- 工作流最终冻结：`engine.ts=2ab92acda7c2fee58e2a177055a1712fac1a02f00024bcef39f44ccc5eb478b0`。定向验证事务重入、事务内 fencing、失效 claim、恢复状态、prune 路径身份、短租约心跳、压力延期 cancel/pause、提交后 GC 失败与符号链接/摘要校验。
- 两位独立复审员对上述哈希均明确报告 `P0=0 / P1=0`；审计误报 V003-038（UPSERT 冲突目标）与 V003-043（MiB/MB）已用源码和回归测试排除。

## 已知非阻断 caveat

- `readArtifact` 的契约仍是先查 manifest 再打开对象；极小窗口内对象被外部删除时返回 `NOT_FOUND`，不会返回错误字节。该行为记录为 P2/契约 caveat，不阻断发行。
- 工件发布为保证 SQLite  fencing 与文件一致性，在 `BEGIN IMMEDIATE` 内使用同步 size/SHA-256 校验；最大工件场景会阻塞本进程事件循环。候选 CI 与后续基准将量化，当前不降低安全语义。

## 明确外部限制

- 本机未安装真实 Ghidra/JDK，Ghidra 适配器通过 fake headless 与故障注入验证，不声称完成真实 Ghidra 样本对照。
- 本机未安装 Docker，Linux 容器构建与健康验收由候选 CI 执行。
- Windows 便携 ZIP 已真实解包并通过 smoke；本机 NSIS 工具下载遇到网络 EOF，安装包静默安装由候选 CI 执行。真实 BrowserWindow GUI E2E 已通过。
