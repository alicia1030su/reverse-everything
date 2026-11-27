# 本地 Agent、CLI、MCP 与 Skill

> Autopilot 可由本地 AI 助手调用，但助手必须遵守同样的授权、确认、预算和证据规则。

## CLI 快速流程

```bash
# 查看已有项目，或先创建一个授权项目
reverse-everything projects list
reverse-everything projects create "My authorized site" website https://example.com --authorized

# 自然语言目标
reverse-everything autopilot create <projectId> "Rebuild https://example.com as a static website" --key site-001
reverse-everything autopilot get <taskId>

# 回答动态问题；确认契约与计划必须是两个显式动作
reverse-everything autopilot answer <taskId> '{"authorizationConfirmed":true,"targetPlatform":"Web"}' --contract
reverse-everything autopilot confirm <taskId> plan

# 观察真实状态、事件与交付
reverse-everything autopilot messages <taskId>
reverse-everything autopilot events <taskId>
reverse-everything autopilot artifacts <taskId>
```

`autopilot answer ... --contract --plan` 可以一次提交，但只应在用户已经阅读并明确同意两者后使用。Agent 不得自行替用户确认。

## MCP

stdio：

```bash
reverse-everything mcp stdio
```

Streamable HTTP：

```bash
reverse-everything mcp http --port 4174
```

Autopilot 工具：

- `autopilot_create`
- `autopilot_list`
- `autopilot_get`
- `autopilot_answer`
- `autopilot_confirm`
- `autopilot_action`
- `autopilot_messages`
- `autopilot_artifacts`
- `autopilot_tutorial`
- `autopilot_download`

MCP 不暴露清理、设备打开、实时捕获、刷写、驱动安装或任意宿主任意命令。HTTP MCP 不读取本机路径；需要本机文件时使用 base64 上传或 stdio 的允许目录机制。

MCP 下载大于 5 MiB 时改用 CLI。stdio 只有显式启用本机文件写入时才接受 `destination`。

## REST 与 SSE

基础路径：`http://127.0.0.1:4173/api/autopilot`。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/tasks` | 创建任务，支持 `Idempotency-Key` |
| GET | `/tasks?projectId=...` | 项目内列表 |
| GET | `/tasks/:id` | 任务详情 |
| POST | `/tasks/:id/answers` | 回答与契约/计划批准 |
| POST | `/tasks/:id/pause`、`/resume`、`/cancel` | 安全控制 |
| GET | `/tasks/:id/messages` | 持久化消息 |
| GET | `/tasks/:id/artifacts` | 工件清单 |
| GET | `/tasks/:id/artifacts/:name` | 校验后下载 |
| GET | `/tasks/:id/events` | SSE 事件流 |

所有请求需 Bearer 本地令牌。`Idempotency-Key` 只能用于相同项目和相同提示词；不同请求复用会返回 409。

## Skill

`skills/reverse-everything/SKILL.md` 要求助手：

1. 先核实授权与目录白名单。
2. 自然语言目标优先使用 `autopilot_create`。
3. 展示动态问题、契约和计划。
4. 获得用户明确确认后才执行。
5. 轮询或订阅真实事件，不编造进度。
6. 区分 `EVIDENCE`、`INFERENCE`、`UNKNOWN`、`VERIFIED`。
7. 只下载清单内工件并核对 SHA-256。

## 本地代理安全建议

- 默认只授予单个项目所需权限，不共享管理员令牌。
- 对删除、取消、远程共享、构建执行和部署保留人工确认。
- 记录任务 ID、计划版本、用户确认和下载哈希，便于审计。
- 不把任意自然语言直接转成宿主机 shell。
- Agent 不能把规则型成功描述为“AI 自主完成”，也不能把 Mock 测试描述为真实模型验收。
