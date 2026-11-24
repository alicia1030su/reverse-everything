# v0.0.3 Phase 0 只读基线审计

审计时间：2026-11-24 UTC+8。审计性质：只读检查 + 可重复基线测试；未修改业务代码、未移动历史 Tag、未覆盖 Release。

## 1. Git / GitHub 真实状态

- 审计前本地分支：`fix/v002-desktop-smoke`，HEAD `a13decaef2c0993a7df9f0dd500236e350d66945`，工作区干净，但落后远端 main。
- 通过 HTTP/1.1 成功 fetch；远端 main 与 GitHub API 均为 `38a781c1f88b46f0a5a658046f1a9b426eecedda`。
- 从远端 main 创建 `feat/v0.0.3-deep-reverse`，基线 HEAD 与 origin/main 一致。
- 开放 PR：0；开放 Issue：0；无 v0.0.3 既有开发记录。
- `v0.0.1` Tag 存在；`v0.0.2` annotated Tag object `3c90680007157b207bd1097c78d6d924a060cb78`，解引用 Commit `b052e64d39f0d1299ea34411746c8e592da70004`。
- v0.0.2 Release：正式、非草稿、非预发布，8 个资产；公开 API digest 与 SHA256SUMS 一致。
- **历史追溯差异确认**：v0.0.2 Tag 指向 b052e64，最终 main/资产构建源为 38a781c。v0.0.3 必须修复该流程，且不得移动历史 Tag。

## 2. 环境

- Windows 11 x64，Node 22.22.2，Git 2.56.1，GitHub CLI 2.105.0，npm 10.9.7。
- 可用物理内存约 18.7GB / 总 33GB。
- 本机无 Docker、pnpm、Python、Java、GCC、Clang；Chrome 与 Playwright Chromium 可用于网页测试。
- 大型容器/原生工具验证必须由 CI 或用户指定路径完成；不得静默安装系统工具。

## 3. 可重复基线

实际执行：

- `npm run typecheck`：通过。
- `npm run lint`：通过，0 warnings。
- `npm test`：6 文件、31 项全部通过。
- 既有 CI：main 最近一次 CI 全绿；v0.0.2 Release 工作流最终成功。
- 历史失败工作流仍保留为证据，不得删除或隐藏。

## 4. 模块现状

| 模块 | 现状 | 主要缺口 |
|---|---|---|
| API | Fastify、/api/v1 别名、统一错误、限速、SSE | 无备份/恢复、深分析器、缓存分类、完整 OpenAPI 同步 |
| Web | 深色 React 控制台、任务/证据/运维页面 | 无多页面重建、Ghidra/APK/协议/Agent/备份工作台 |
| Electron | NSIS/便携版、Sidecar、cookie、smoke | 无完整 GUI 任务 E2E、升级/卸载/孤儿进程实测 |
| Worker | 独立进程、检查点、资源采样 | 阈值配置不一致、无迟滞、CPU/磁盘压力、自适应并发 |
| SQLite | Schema 2、WAL、busy_timeout、迁移前 VACUUM 备份 | 无 Schema 3、备份中心、恢复预览、完整故障注入 |
| 缓存 | 项目隔离、原子 rename、LRU、哈希校验 | 无 single-flight、miss 计数、分类、AI/网页/验证缓存、活跃引用保护 |
| 文件/原生 | PE/ELF/Mach-O 元数据、字符串、ZIP、SBOM | 无 Ghidra、WASM/Class/.NET 深入分析 |
| Android | 仅 ZIP 清单 | 无 Manifest/DEX/组件/权限适配器 |
| 网络记录 | 实时同源 NDJSON、WebSocket 回放 | 无 HAR/PCAP/PCAPNG 导入 |
| 网页 | 单页 DOM/脚本/截图/网络 | 无多页面状态机、兼容重建、自动对比修复 |
| 游戏 | L3 回放兼容服务 | 无状态持久化、账号/物品/断线恢复，未达 L4 |
| 安全 | 被动 HTTP、静态规则、SARIF | 无依赖漏洞匹配、AI 研判闭环、主动验证环境 |
| AI | OpenAI 兼容摘要、INFERENCE | 无规划/执行/修正闭环、结构化输出、模型路由与预算 |
| CLI/MCP/Skill | CLI、17 工具、stdio+HTTP、标准 Skill | 无深分析器工具、备份/搜索/Agent 工作流、真实 Skill 任务 |
| 发行 | EXE/ZIP/TGZ/SBOM/OpenAPI/SHA | 无 BUILD-INFO、RELEASE-MANIFEST、冻结 Commit 门禁、来源证明 |

## 5. 已确认高风险点

1. **P0 发行流程**：v0.0.2 workflow 仍允许 preflight Tag 发布正式 Tag，且无 Tag dereference == build Commit 的硬校验。
2. **P0 迁移**：仅 user_version 2；备份失败发生在事务外，损坏 DB、只读目录、WAL/SHM、中断恢复缺少系统化处理。
3. **P0 资源**：Worker 的 `thresholds` 使用 DEFAULT，而 ResourceMonitor 读取环境变量，任务预算可能偏离实际熔断阈值；无恢复迟滞。
4. **P1 缓存**：misses 永不增加；无 single-flight；put 临时文件名仅时间戳；无分类/引用保护；网页与 AI 结果未缓存。
5. **P1 运行**：API `/api/health` 每次触发进程树采样；PowerShell/CIM 采样成本高；桌面进程树未纳入统一资源视图。
6. **P1 能力声明**：README 仍把多页面/Ghidra/APK/HAR 等列为未实现；v0.0.3 文档必须随真实交付更新，不得提前宣称。
7. **P1 版本**：版本号散落在 package.json、CLI、MCP、Electron、OpenAPI、打包脚本和文档，易产生不一致。

## 6. 审计结论

v0.0.2 基线可构建、可测试、可运行，但尚不具备 v0.0.3 要求的灾难恢复、完整资源治理、深度逆向与可证明发行能力。实施顺序：先修发行/数据 P0，再修缓存/资源 P1，然后扩展分析器与重建，最后执行六入口和 Windows 完整验收。不得用新功能掩盖旧缺陷。
