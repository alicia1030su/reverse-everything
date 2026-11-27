# 任务恢复、暂停与排障

## 持久化模型

Autopilot 将任务、意图、问题、答案、契约、计划、消息、步骤结果、工件索引、指标与事件保存在 SQLite。关键恢复字段包括：

- `stateVersion`：状态版本。
- `planVersion`：计划版本。
- `checkpoint`：恢复状态、当前步骤、计划批准信息。
- `leaseOwner` / `leaseExpiresAt`：工作租约，防止多 worker 同时执行。
- `autopilot_step_results`：已成功步骤的真实输出，用于恢复时跳过。

## 暂停与恢复

1. 打开 `/autopilot/:id`。
2. 活跃状态点击“暂停”；系统在安全检查点记录 `PAUSED`。
3. 需要继续时点击“恢复”。
4. 任务回到 `PLANNING`，从首个未完成步骤继续；已成功步骤不会重复执行。

CLI：

```bash
reverse-everything autopilot action <taskId> pause
reverse-everything autopilot action <taskId> resume
reverse-everything autopilot action <taskId> cancel
```

取消是终态，不会自动恢复。取消不会删除已有工件。

## 进程崩溃与租约过期

服务启动时调用恢复逻辑：过期 `RUNNING` / `REPAIRING` 租约会被清空，并根据 checkpoint 回到 `PLANNING` 或 `PAUSED`。恢复只重建可执行状态，**不会虚构步骤成功结果**。

随后轮询循环领取已批准计划。成功步骤从持久化结果复用；失败步骤是否重试受步骤类型、重试预算和无进展熔断限制。

## 常见错误

| 错误 / 状态 | 含义 | 建议 |
|---|---|---|
| `AUTOPILOT_PLAN_MISSING` | 契约或计划不存在 | 完成需求与批准，不要直接调用执行 |
| `AUTOPILOT_APPROVAL_REQUIRED` | 计划未批准 | 阅读计划后显式确认 |
| `AUTOPILOT_STATE_CONFLICT` | 当前状态不允许该操作 | 刷新任务，检查是否终态或运行中 |
| `AUTOPILOT_FORBIDDEN` | 超出契约权限 | 新建任务并重新确认合法范围 |
| `AUTOPILOT_WORKFLOW_MISSING` | 未配置真实工作流 | 检查服务端装配，不要用 Mock 顶替 |
| `AUTOPILOT_CHILD_FAILED` | 子任务真实终态失败 | 查看子任务错误和证据 |
| `AUTOPILOT_CHILD_TIMEOUT` | 等待子任务超时 | 检查子任务、资源与预算 |
| `AUTOPILOT_CIRCUIT_OPEN` | 连续无进展触发熔断 | 查看重复失败原因；修正后新建任务 |
| `TOOL_FORBIDDEN` | 工具权限不足 | 检查契约允许操作 |
| `TOOL_CWD_FORBIDDEN` | 工具 cwd 越界 | 使用任务隔离工作区 |
| `TOOL_EXECUTION_FAILED` | allowlist 构建失败 | 查看 stderr、工程依赖与脚本 |
| `DELIVERY_HASH_MISMATCH` | 工件大小或哈希变化 | 停止交付，检查来源是否被修改 |

## 升级与备份

Schema 6 → 7 会新增 Autopilot 表。升级前停止所有写入进程并备份整个 `data/`，包括 SQLite、WAL/SHM、上传、工件、缓存、`secret.key`、`local-token` 和 `backups/`。自动数据库备份不能替代完整备份。

回滚旧版本时必须恢复升级前完整备份；不要手改 `PRAGMA user_version` 或删除新表。详见 [升级指南](user-guide/UPGRADE.md)。

## 不要做的事

- 不要删除 `autopilot_step_results` 来“强制重跑”，这会破坏幂等与证据链。
- 不要把 `FAILED` 手改为 `COMPLETED`。
- 不要在任务运行时直接复制或修改 SQLite 文件。
- 不要用 Mock 子任务填补缺失的真实终态。
- 不要在未检查授权和工件哈希时执行下载内容。
