# v0.0.8 最终报告

> 状态：冻结前本机门禁通过，待 PR CI、候选资产与正式发行。更新：2026-11-27。

## 执行摘要

v0.0.8 新增 `@reverse/autopilot` 统一调度层，并接入 Web、REST、CLI、MCP 与 Skill。核心闭环包括自然语言目标、动态需求发现、目标契约、依赖计划、持久化执行、暂停/恢复/取消、真实分析器复用、本地构建工具、独立规则验收和交付中心。

当前实现以规则型、本地优先执为主。Provider V4 已具备多角色配置、能力探测、预算、结构化输出与故障切换基础，但真实远程模型尚未接入完整 Autopilot 主链，真实 Key E2E 保持 `UNVERIFIED / BLOCKED`。

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

## 真实证据

| 门禁 | 结果 |
|---|---|
| 全量 Vitest | 901 passed / 9 skipped / 0 failed；182 suites |
| 完整 Playwright E2E | 32/32 passed |
| build / typecheck / lint | PASS |
| docs / defects / version / Skill / secrets / licenses / audit | PASS |
| 独立冻结复审 | P0=0、P1=0 |
| Engine 性能基准 | 17 tasks，0 failed；冷/热 P95 169.79/218.38ms |
| E2E 性能基准 | 文件/网页/游戏 563/5073/2104ms，passed=true |
| 原客户端与演示 ZIP | Pixelknight/Tron 2/2；干净解包/安装/测试/启动通过 |
| 真实远程模型 | BLOCKED：V008-003，无 Key |

详见 `V008-TEST-RESULTS.md`、`V008-PERFORMANCE.md`、`V008-SECURITY-AUDIT.md`。

## 已知限制

- 规则型意图识别可能误判，必须由用户复核契约。
- 自动修复是有限重试，不是完整模型驱动重规划。
- 静态站点生成是独立候选，不保证原站复刻或业务兼容。
- 非 Web 目标缺少可信工程时不会伪造可运行成品。
- 长期记忆、完整多智能体、跨任务知识检索尚未完成。
- Provider 用量不是完整跨进程计费系统。
- 大文件、物理设备、商业客户端与所有平台兼容仍需独立证据。
- 真实远程模型未验证；不得以 Mock 或规则型结果关闭 V008-003。

## 发行决定

**本机冻结门禁已通过，但尚未正式发布。** 必须完成 PR CI、候选资产验收、Tag/Build/Acceptance 一致性、Draft 上传校验和公开下载复验。失败时保留 v0.0.7，不覆盖历史 Release，不伪造签名、截图或真实验收。

## 回填区

| 项目 | 当前值 |
|---|---|
| 冻结 Commit | 待提交 |
| 全量测试 | 901 passed / 9 skipped / 0 failed |
| E2E | 32/32 |
| 安全结论 | P0=0 / P1=0 |
| 性能结论 | 本机 Engine/E2E 基准通过 |
| 真实模型 | BLOCKED：V008-003 |
| 候选资产 SHA256 | 待候选 |
| Tag / Release / Run | 待发行 |
| 公开复验 | 待发行 |
