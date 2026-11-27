# v0.0.8 模型验证报告

> 日期：2026-11-27。结论：Provider V4 的规则/Mock 测试通过；真实远程模型端到端验收 `BLOCKED / MISSING_API_KEY`，正式发行证据见 Release 资产 `v008-model-validation.json` 对应的 `real-model-validation` 工件。

## 验证分层

| 层级 | 方法 | 当前结果 | 证据 |
|---|---|---|---|
| 规则型 | 意图、计划、工具、交付测试 | PASS | `tests/unit/autopilot.test.ts` 28 项 |
| Provider Mock | 模拟 HTTP 响应、失败切换、预算、Schema、脱敏 | PASS | `tests/unit/model-providers.test.ts` 17 项 |
| API 集成 | Fastify 注入、认证、项目隔离、工件篡改、SSE | PASS | `tests/integration/autopilot-api.test.ts` 8 项 |
| Provider API 集成 | 配置、角色、远程同意、能力探测 | PASS | `tests/integration/model-providers-api.test.ts` 4 项 |
| 本地真实模型 | 本机 Ollama 等端点实测 | UNVERIFIED | 未提供固定模型与服务日志 |
| 真实远程模型 | 真实 Key + 真实端点 + 完整 Autopilot 任务 | UNVERIFIED / BLOCKED | V008-003 |

2026-11-27 最终分平台运行：Ubuntu 906 passed / 7 skipped，Windows 905 passed / 8 skipped，完整 E2E 32/32。正式候选 Run `45986134905` 与发行 Run `45994026211` 均记录了 `status=BLOCKED`、`error.code=MISSING_API_KEY`、`realModelCalled=false`。这些结果不是真实模型证据。

## Provider V4 已验证行为

- OpenAI 兼容请求发往 `/chat/completions`；Ollama 发往 `/api/chat`。
- 角色候选按分配顺序和优先级选择，支持 fallback。
- chat/stream/tools/structuredOutput 通过真实探测结果更新；vision 不自动证明。
- 结构化输出解析后执行有界 JSON Schema 校验。
- 单次/单任务 Token 预算、费用预算、速率限制、超时与重试。
- API Key 不返显，网络错误脱敏。
- 远程 Provider 必须 HTTPS 且显式同意；safeFetch 默认不跟随重定向。

## 尚未验证

1. 真实远程 Key 的 chat、tools、structuredOutput、vision 逐项结果。
2. 真实模型完成意图分类、动态规划、工具选择和交付任务的完整闭环。
3. 不同服务商对 JSON Schema、流式响应、工具调用的兼容性。
4. 模型输出在长上下文、对抗性目标材料下的稳定性。
5. 多模型费用对账、进程重启后的完整用量一致性。
6. 真实模型故障切换与预算耗尽的生产行为。

## 真实模型验收模板（待回填）

| 字段 | 值 |
|---|---|
| 验收日期 / Commit | 2026-11-27 / `d2334ee267098e30f44b72c80f975e520abbc47c` |
| Provider / 端点 / 模型 | openai-compatible；端点与模型未配置 |
| 数据共享同意记录 | 未发生真实模型调用 |
| 任务 ID / 原始目标 | 未执行真实模型任务 |
| 意图与计划结果 | UNVERIFIED |
| 工具调用证据 | UNVERIFIED |
| Token / 费用 / 耗时 | 0 / 0 / 0；未调用 |
| 独立验收状态 | BLOCKED：`MISSING_API_KEY` |
| 限制与失败分支 | `realModelCalled=false`；不以 Mock 或规则型替代 |

无真实 Key 时保持 `BLOCKED`，不得以 Mock 或规则型结果关闭 V008-003。
