# v0.0.8 缺陷登记

状态：OPEN / IN_PROGRESS / FIXED / VERIFIED。P0/P1 在正式发行前必须清零。

| ID | 级别 | 缺陷 | 证据/触发条件 | 修复方案 | 状态 |
|---|---|---|---|---|---|
| V008-001 | P1 | 现有 AnalysisPlan 是固定确定性流程，不能按自然语言目标动态增删依赖步骤 | `packages/planner/src/types.ts` `deterministic: true` | 新增 Autopilot Dynamic Planner V4，保留旧规划器兼容 | VERIFIED |
| V008-002 | P1 | 模型客户端只有单轮文本补全，缺少 Tool Calling、结构化输出与角色模型管理 | `packages/workflow/src/agent.ts` | 新增 Provider 能力检测、结构化校验、Tool Registry 与预算 | VERIFIED |
| V008-003 | P2 | 真实远程 AI Key 端到端验收受外部凭证阻塞 | 环境未提供 API Key，无法执行真实远程模型调用 | 已提供可重复验收脚本与 Mock/规则型分层；获得 Key 后运行 `scripts/validate-real-model.mjs` | OPEN |
| V008-004 | P1 | 分析报告不是成品交付闭环 | 现有任务以 REPORT/EXPORT 结束 | 新增 Build-Test-Repair、独立验收与交付中心 | VERIFIED |
| V008-005 | P1 | 自然语言多轮需求发现、目标契约与长期项目记忆缺失 | 现有 Wizard 为固定表单 | 新增 Conversation/Requirement Discovery/Goal Contract/项目记忆 | VERIFIED |
| V008-006 | P1 | CLI/MCP 确认计划时缺少契约批准，导致已批准计划无法启动 | `autopilot confirm plan` 与 `autopilot_confirm(kind=plan)` 仅发送 `approvePlan=true` | 计划确认同时发送 `approveContract=true` 与 `approvePlan=true`；`tests/integration/autopilot-api.test.ts` 真实 API 回归 8/8 | VERIFIED |
| V008-007 | P1 | Provider 连续请求的 Token 预算被后续结算重置，可绕过累计上限 | `settle` 使用 `Math.max(0, budget.tokens - reserved.tokens)` 抹掉其他已完成调用占用 | 改为累计扣减/结算；连续小请求累计到上限后拒绝，`model-providers.test.ts` 21/21 | VERIFIED |
| V008-008 | P1 | Provider 接受负数、非整数或缺失 usage，可污染或绕过预算 | 负数 Token 产生负预算；缺失 usage 默认 0 释放预留 | 严格校验非负安全整数；缺失 usage 按输入估算加输出上限保守结算；21/21 Provider 回归 | VERIFIED |
| V008-009 | P1 | Autopilot 长任务与交付过程无租约续期，过期后可能重复执行或虚假成功 | analyzer/本地工具/大工件复制超过默认 15s lease | run 与 deliver 均启动 CAS heartbeat；续租失败立即 abort 并禁止成功；24MB 工件与续租失败回归通过 | VERIFIED |
| V008-010 | P1 | Autopilot 周期不恢复过期租约，暂停后子工作流无法恢复 | `tickOnce` 未调用 `recover`；`resume` 未恢复 PAUSED child | 每轮先 recover；resume 先恢复子任务；清理续租失败后的无效 child；Autopilot 28/28 | VERIFIED |
| V008-011 | P1 | Autopilot 执行开始后仍可修改目标/材料并复用旧步骤结果 | PAUSED 状态可提交新 target/materials，旧 plan/child 继续存在 | `metrics.startedAt`、attempt、taskId 或成功结果出现后返回 `AUTOPILOT_INPUTS_LOCKED`；执行前仍可修订 | VERIFIED |
| V008-012 | P1 | MCP stdio `autopilot_download` 可覆盖任意路径文件 | 显式 destination 直接 `writeFile`，无根目录与符号链接约束 | 默认有界 base64；仅 stdio + `RE_MCP_DOWNLOAD_ROOTS`；realpath 边界、拒绝 symlink、`wx` 独占创建、HTTP 拒写；8/8 安全回归 | VERIFIED |
| V008-013 | P1 | v0.0.8 冻结门禁强制历史 `Release v007` 在同一提交成功 | `REQUIRED_RELEASE_WORKFLOWS` 固定包含 `Release v007` | 版本感知：三组 push gate + 当前 Release；v007 保持自身门禁，v008 不依赖历史 Release；16/16 工作流回归 | VERIFIED |
| V008-014 | P2 | 历史 `openapi-v0.0.7.json` 被 v0.0.8 路径污染 | 当前生成脚本覆盖已发布版本且 info.version 仍为 0.0.7 | 恢复正式 v0.0.7 字节；登记不可变 SHA-256；生成器拒绝覆盖已发布版本；OpenAPI 3/3 | VERIFIED |
| V008-015 | P1 | v0.0.8 候选打包演示资产时缺少当前提交的原客户端 E2E 证据 | `package-demo-assets.mjs` 要求 `GAME_COMPAT_EVIDENCE_DIR`，Release 工作流未生成 | 先运行 `game-compat.spec.ts`，再通过同一临时目录绑定 `package:demos`；工作流顺序与环境变量断言通过 | VERIFIED |
| V008-016 | P2 | Provider 成本单位曾放大 100 倍，导致费用统计与预算提前耗尽 | `costMicrousd` 旧换算未按每百万 Token 美元价格正确换算 | 统一以 micro-USD 记账，预算按 `1_000_000` 换算为 USD；`model-providers.test.ts` 累计用例断言 10 次调用 `costUsd=0.0011`，Provider 核心/API 21/21 通过 | VERIFIED |
| V008-017 | P1 | Tron 原客户端 E2E 在服务端重启前卡死于 `close()` | Socket.IO `io.close()` 回调等待 HTTP server 关闭，活跃连接又阻塞该回调 | 先启动关闭并强制断开所有 HTTP 连接，再等待 Socket.IO 关闭；Tron 原客户端刷新/重启用例单独重跑 1/1 通过 | VERIFIED |
| V008-018 | P1 | 干净 CI 构建因 workspace 拓扑顺序错误失败 | 根 build 先构建 `@reverse/workflow`，但其类型依赖 `@reverse/planner`；本机旧 dist 掩盖问题 | 调整根 build 与 tsconfig references 顺序，补 workflow 依赖声明与构建拓扑回归；清除全部 dist 后从零构建通过 | VERIFIED |
| V008-019 | P1 | Legacy API 响应泄露本机绝对路径 | 任务 options、直接路径证据 source/content、Legacy profile sourcePath 与重建工件包含绝对路径；Linux JSON 正斜杠使现有断言失败 | API 统一递归脱敏绝对路径并覆盖 SSE/事件/证据检索；Legacy 公开分析仅保留 basename，恢复执行从受控输入重新解析；强化跨平台回归 | VERIFIED |

> 本表在 Phase 0 独立审计后追加全部可复现缺陷；不得用删除测试或降低断言关闭缺陷。V008-003 为外部凭证阻塞的 OPEN P2，不影响 P0/P1 清零判定，但不得宣称真实远程模型已验证。
