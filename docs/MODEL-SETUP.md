# 模型配置与真实能力验证

> 当前为 v0.0.8 开发实现。Provider V4 API 已存在，但 Autopilot 主执行链仍以规则型调度为主；真实远程模型 E2E 尚未验收。

## 无模型也能做什么

不配置 Provider 时，仍可进行规则型意图识别、动态追问、目标契约、确定性依赖计划、真实本地工具执行、独立规则验收和交付。页面中的“模型调用”通常为 0，这不是故障。

## 模型管理页

打开 `/models`。V4 API 可用时显示 Provider 管理；API 不可用时回退到旧单模型设置，并明确提示“API 未启用”，不会伪造角色路由。

### 新增 Provider

1. 点击“新增”。
2. 填写名称、类型、Base URL、模型名。
3. 类型可选 `openai-compatible`、`ollama`、`custom`。
4. 本地模型通常无需 Key；远程服务填写 API Key。Key 只写不返显。
5. 设置角色、优先级、能力声明与预算。
6. 远程 Provider 必须勾选远程数据共享授权；远程 Base URL 必须使用 HTTPS。
7. 保存后点击“测试连接”。

Base URL 示例：

- OpenAI 兼容：`https://your-provider.example/v1`，实际请求路径为 `/chat/completions`。
- Ollama：`http://127.0.0.1:11434/v1`，实际请求路径为 `/api/chat`。

以上仅为格式示例，不保证某个服务商或模型可用。

## 角色

`main` 主控、`light` 轻量任务、`code` 代码生成、`multimodal` 多模态、`reviewer` 独立复审、`fallback` 故障切换。

角色分配决定候选顺序；未命中时可回退到启用的 `fallback` Provider。优先级数值越小越优先。能力不足的候选会被跳过。

## 能力检测

服务端对 chat、stream、tools、structuredOutput 发起真实探测，只有成功的探测才标记为可用；vision 当前不由探测自动证明。手动勾选只代表配置意图，不能替代真实探测。

探测成功也不代表该模型已经完成 Autopilot 任务验收。

## 预算与用量

可配置：

- 超时、重试次数、每分钟请求数。
- 单次与单任务 Token 上限。
- 单任务费用上限及输入/输出单价。
- 结构化输出 Schema 校验。

`GET /api/models/usage` 返回进程内与已持久化用量，范围为 `process-and-persisted`。它不是跨进程完整账单系统。

## API 示例

```bash
curl http://127.0.0.1:4173/api/models/providers \
  -H "Authorization: Bearer $RE_API_TOKEN"

curl -X POST http://127.0.0.1:4173/api/models/providers/local/test \
  -H "Authorization: Bearer $RE_API_TOKEN"
```

本地令牌默认位于 `RE_DATA_DIR/local-token`。不要在命令行历史、截图或仓库中暴露真实 Key。

## 未验证限制

- 真实远程 Key 的完整 Autopilot 目标任务：`UNVERIFIED`。
- 真实模型驱动的意图分类、动态重规划与多智能体协作：尚未接入主链路。
- 不同服务商的工具调用、视觉、流式和 JSON Schema 兼容性：需逐项实测。
- 成本估算依赖配置单价；缺失单价按 0 计算，不代表服务免费。
- 进程重启后的全部用量一致性：尚未作为完整计费系统验收。
