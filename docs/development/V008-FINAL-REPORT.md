# v0.0.8 最终报告

> 状态：已正式发布。更新：2026-11-27。

## 执行摘要

v0.0.8 新增 `@reverse/autopilot` 统一调度层，并接入 Web、Desktop、REST、CLI、MCP stdio/HTTP 与 Skill。核心闭环包括自然语言目标、动态需求发现、目标契约、依赖计划、持久化执行、暂停/恢复/取消、真实分析器复用、本地构建工具、独立规则验收和交付中心。

当前实现以规则型、本地优先执行为主。Provider V4 已具备多角色配置、能力探测、预算、结构化输出与故障切换基础，但真实远程模型尚未接入完整 Autopilot 主链。正式候选的真实 Key 端到端验收如实记录为 `BLOCKED / MISSING_API_KEY`，未以 Mock 或规则型结果冒充真实模型能力。

## 正式发行信息

| 项目 | 值 |
|---|---|
| 产品版本 | 0.0.8 |
| Schema | 7 |
| 冻结 / Build / Acceptance Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| Annotated Tag object | `79da5c63649ede8001457ae80dbe6c9b0a7335fc` |
| Tag 解引用 Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| 候选验收 Run | `45986134905` |
| 正式原子发行 Run | `45994026211` |
| Release | https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.8 |
| 发布时间 | 2026-11-27T12:11:55Z |
| 资产数量 | 15 |
| Draft / Prerelease / Latest | `false` / `false` / Latest 指向 v0.0.8 |
| 公开复验 | 15 个资产名称、大小、digest 与 SHA256SUMS 一致；公开地址重下载复验通过 |

## 已交付实现

| 模块 | 内容 |
|---|---|
| 核心 | intent、questions、contract、planner、engine、tools、delivery、providers |
| 数据 | Schema 7 Autopilot 任务、消息、步骤结果、工件表 |
| API | `/api/autopilot/*` 与 `/api/models/*` |
| Web | `/autopilot`、`/delivery`、`/models`，默认首页升级为 Autopilot |
| CLI | `autopilot create/list/get/answer/confirm/action/messages/artifacts/download/events` |
| MCP | 10 个 `autopilot_*` 工具，总计 54 个；下载默认不写盘 |
| Skill | 授权、确认、真实事件、证据与哈希纪律 |
| 文档 | 用户/开发文档、中英文 README、OpenAPI v0.0.8 与历史契约保护 |

## 最终测试证据

| 门禁 | 结果 |
|---|---|
| Ubuntu 全量 Vitest | 906 passed / 7 skipped / 0 failed；913 total |
| Windows 全量 Vitest | 905 passed / 8 skipped / 0 failed；913 total |
| 完整 Playwright E2E | Ubuntu/Windows 均 32/32 passed |
| build / typecheck / lint | PASS |
| docs / defects / version / Skill / secrets / licenses / audit | PASS |
| 独立冻结复审 | P0=0、P1=0 |
| Engine 性能基准 | 17 tasks，0 failed；冷/热 P95 169.79/218.38ms |
| E2E 性能基准 | 文件/网页/游戏 563/5073/2104ms，passed=true |
| 原客户端与演示 ZIP | Pixelknight/Tron 2/2；干净解包/安装/测试/启动通过 |
| Windows 发行 smoke | 安装、Portable、v0.0.7→v0.0.8 升级与数据保留、Game Revival、Legacy 独立启动通过 |
| Docker | 镜像健康检查、FPS/RPG 真实部署与独立证据复核通过 |
| 真实远程模型 | BLOCKED：V008-003，`MISSING_API_KEY`，`realModelCalled=false` |

详见 `V008-TEST-RESULTS.md`、`V008-PERFORMANCE.md`、`V008-SECURITY-AUDIT.md`、`V008-DEFECT-REGISTER.md`。

## 30 项交付清单

| # | 交付项 | 状态 |
|---|---|---|
| 1 | v0.0.7 正式基线与只读审计 | PASS |
| 2 | V008 审计、缺陷、能力矩阵与计划文档 | PASS |
| 3 | Conversation Engine 与多轮消息持久化 | PASS |
| 4 | Intent Engine 与多目标拆分 | PASS |
| 5 | Requirement Discovery Engine 与动态问题 | PASS |
| 6 | Goal Contract 与显式批准 | PASS |
| 7 | Dynamic Planner V4 与依赖 DAG | PASS |
| 8 | Durable Autopilot Orchestrator、租约与恢复 | PASS |
| 9 | 多智能体角色与模型路由基础 | PASS / 完整多智能体为 PARTIAL |
| 10 | Model Provider V4、SecretStore 与预算 | PASS |
| 11 | Tool Registry、权限、Schema 与命令 allowlist | PASS |
| 12 | Evidence Knowledge Base 与项目证据索引 | PASS / 跨任务完整检索为 PARTIAL |
| 13 | Product Reconstruction Engine 与独立成品 | PASS |
| 14 | Build-Test-Repair Loop 与受限重规划 | PASS |
| 15 | Independent Delivery Reviewer | PASS |
| 16 | Artifact Delivery Center、教程与 SHA-256 | PASS |
| 17 | Web/Desktop ChatGPT 式自然语言工作台 | PASS |
| 18 | REST/CLI/MCP/Skill 全入口共享核心 | PASS |
| 19 | Schema 7 迁移与旧数据兼容 | PASS |
| 20 | 安全边界、路径脱敏与 MCP 下载限制 | PASS |
| 21 | 全量单元/集成测试与分平台 CI | PASS |
| 22 | Web/Electron 完整 E2E 与原客户端兼容 | PASS |
| 23 | 性能基准、资源预算与熔断 | PASS |
| 24 | 独立 P0/P1 复审与缺陷清零 | PASS |
| 25 | Linux CLI/Server/Skill/Docker 候选验收 | PASS |
| 26 | Windows EXE/Portable/升级/Legacy 候选验收 | PASS |
| 27 | 候选资产、provenance、ACCEPTANCE 与清单 | PASS |
| 28 | annotated Tag、唯一 Draft 与原子公开 | PASS |
| 29 | 公开下载复验、Latest 与 OpenAPI 哈希登记 | PASS |
| 30 | 最终报告、README、路线图与升级文档回填 | PASS |

## 已知限制

- 规则型意图识别可能误判，必须由用户复核契约。
- 自动修复是有限重试，不是完整模型驱动重规划。
- 静态站点生成是独立候选，不保证原站复刻或业务兼容。
- 非 Web 目标缺少可信工程时不会伪造可运行成品。
- 长期记忆、完整多智能体、跨任务知识检索尚未完成。
- Provider 用量不是完整跨进程计费系统。
- 大文件、物理设备、商业客户端、macOS 与所有平台兼容仍需独立证据。
- 真实远程模型未验证；不得以 Mock 或规则型结果关闭 V008-003。

## 发行决定

**v0.0.8 已达到正式发行标准并已发布。** Tag Commit、Build Commit、Acceptance Commit 一致；15 个资产已上传、逐项校验并完成公开复验。V008-003 保持 OPEN P2 / BLOCKED，不影响 P0/P1 清零结论，但不得宣称真实远程模型已验证。
