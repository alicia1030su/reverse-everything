# V007 执行计划

更新：2026-11-26。分支：`feat/v0.0.7-legacy-revival`。发布策略：正常 PR/CI/main 冻结，保留原 10 项资产并新增游戏兼容演示 ZIP、Legacy 演示 ZIP 与 demo-evidence.json，共 13 项原子发行；任何 P0/P1 未清零或真实验收缺证据时不得发布。

## 项目启动

- 项目类型：本地逆向/兼容重建工作台（Web + API + Worker + CLI/MCP + Electron + Docker）。
- 终极功能：在合法授权范围内，把实际证据转化为可验证的独立兼容实现，并让普通用户完成游戏/老软件分析、数据恢复与独立重建。
- In scope：证据驱动游戏引擎、Legacy Studio、软件重建、数据恢复、本地隐私、全入口同步、工程治理、文档与原子发布。
- Out of scope：商业服务端源码/账号数据库/密钥使用，认证/DRM/反作弊绕过，盗版激活，未授权资源分发，未授权设备操作。
- 验收：反模板游戏行为差异、真实原客户端兼容（或明确外部阻塞）、老软件独立产物实际启动、数据恢复真实性、724+26 历史回归、P0/P1=0、Tag=Build=Acceptance。

## Wave 1：基线与真实性（Phase 0-1）

- [x] 核实 Commit、Release Run、12 资产、Schema 5、44 MCP、724/9 与 26/26。
- [x] 完成四份 V007 审计文档。
- [x] 修复证据标签与 Actions Node24 依赖。
- [x] 建立两个独立保留的反模板样本与行为 IR。
- [x] 对比文件分析、行为规格、生成实现和联机结果。

## Wave 2：游戏兼容 V5（Phase 2-4）

- [x] 建立引擎识别、行为建模、合法通信证据、状态模型、功能规格、独立实现、测试与部署模块。
- [x] 生成器消费行为 IR；FPS/RPG 模板降为显式基础组件。
- [x] 选择许可明确的 Pixelknight/Tron，使用保留的原始浏览器客户端完成独立服务兼容验收。
- [x] 更新 CODOL 2021 六维状态；无客户端/授权保持 EXTERNAL_BLOCKED。

## Wave 3：古老软件核心（Phase 5-10）

- [x] 只读软件档案：PE/ELF/Mach-O/MSI/JAR/Electron/Python/SQLite/CSV/DBF/INI/JSON/XML/目录。
- [x] 兼容诊断与合法许可诊断；外部工具只给建议，安装需确认。
- [x] 独立软件功能规格、代码/UI 生成、构建、测试与产物。
- [x] 数据恢复引擎与独立导出目录。
- [x] Local Privacy Center：本地分析、远程共享确认、网络/下载透明、保留策略。

## Wave 4：产品入口（Phase 11-14）

- [x] Legacy Studio 傻瓜流程与专业工作台。
- [x] Free Alternative Finder 官方来源/许可证/功能差异。
- [x] AI V3 角色、结构化输出、有界工具、取消/恢复；无 Key 不宣称 AI 实测。
- [x] A-E 真实验收样本与独立保留数据。

## Wave 5：全量治理（Phase 15-18）

- [x] 修复大文件内存、扫描/生成安全、状态隔离、持久化、资源熔断、导出、升级和运行时闭包。
- [x] 生产默认配置与负载配置分离；v0.0.7 64 客户端与长稳复验。v0.0.6 性能 JSON 因 Commit 不匹配保留为 V007-007，不作为本版本发行证据。
- [x] API/OpenAPI/CLI/MCP/Skill/Web/Desktop/Docker 同源同步。
- [x] 中英文 README 与六份专题文档、真实截图。

## Wave 6：回归与发布（Phase 19-21）

- [x] 历史 724 测试、26 E2E、Ghidra、JADX、安全/性能/安装/Docker 全量回归。
- [x] 独立复审 P0/P1=0；发布 PRR 与回滚方案。
- [ ] PR → CI → main → freeze → 候选 → 实际安装 → annotated Tag → 唯一 Draft → Release ID 上传 → 校验 → 一次性公开 → 下载复验。
- [ ] 最终报告逐项回答 14 个交付问题，不只用测试数量证明能力。

## 风险与回退

| 风险 | 缓解 | 回退/对外表述 |
| --- | --- | --- |
| 真实游戏协议过于复杂 | 先选小型开源游戏；协议证据独立保留 | 未完成原客户端兼容则 BLOCKED，不用内部客户端替代 |
| 老软件无法在现代 OS 运行 | 只读诊断 + 用户配置 VM/Wine/DOSBox | 保持 UNKNOWN/外部依赖，不执行未知程序 |
| 内存压力 | 串行重任务、流式、有界缓存、子进程回收 | 保存检查点，降并发，不清理个人目录 |
| 模型不可用 | 确定性规则引擎仍可运行 | AI 验证标为未验证 |
| 发行门禁失败 | 保留上一正式版本，不绕过 | 修复后重新冻结，Tag/Build/Acceptance 必须一致 |

## 实测证据

| 任务 | 命令/来源 | 结果 | 结论 |
| --- | --- | --- | --- |
| 基线测试 | `npm test` | 724 passed / 9 skipped | 通过 |
| 基线 E2E | `npm run test:e2e` | 26/26 | 通过 |
| 发布证据 | GitHub Run `45792899427` | 8 阶段 success | v0.0.6 原子发布成立 |
| 真实性审计 | `spec.ts`/`templates.ts`/`validator.ts` | 固定模板 + 内部客户端 | 需要 V5 改造，不得宣称原游戏兼容 |
| 反模板验收 | `game-revival.test.ts` | 4 个保留样本、不同规格/代码/联机结果；behavior-runtime 逐项断言 | 通过；内部客户端标签正确 |
| 最终全量回归 | `npm test` / `npm run test:e2e` | 67 files，782 passed / 9 skipped；E2E 29/29 | 通过 |
| 发行静态门禁 | build/typecheck/lint/docs/version/skill/secrets/licenses/audit/defects | build、typecheck、lint（0 error）、docs、version、skill、secrets、licenses、defects 均通过；audit 0 vulnerabilities | 通过 |
| 原客户端兼容 | `artifacts/v007-game-compat/*.json` | Pixelknight/Tron 原始客户端、双人操作、重连 | VERIFIED；Pixelknight 重启持久化、Tron 对局结束 |
| Legacy 真实恢复 | `web-v007.spec.ts` | 共享 Worker 恢复、预览、导出与截图 | 通过 |
| 独立软件重建 | `package-demo-assets.mjs` | INI 编辑器真实测试与 HTTP 启动 | VERIFIED |
| 跳过覆盖 | `skip-coverage.test.ts` | 9 项映射、7 项必过断言 | 18 项发行/跳过专项测试通过 |
| v0.0.7 候选验收 | Release Run `45907562071` | Linux/Windows/Docker/升级/Legacy/Game smoke 全通过；13 项 manifest 资产与 15 个候选文件 SHA256SUMS 一致 | 通过 |

每完成 5 个文件或一个 Wave 更新本计划与检查点；失败项保留证据，不静默跳过。
