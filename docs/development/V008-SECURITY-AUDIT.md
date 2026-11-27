# v0.0.8 安全审计

> 日期：2026-11-27。性质：基于源码、定向测试、独立复审、分平台 CI 与正式候选的审计；v0.0.8 已正式发行。

## 审计范围

- Autopilot 授权、工具权限、隔离 cwd、allowlist 命令。
- REST 认证、项目隔离、幂等、输入边界、SSE 与工件下载。
- Provider V4 密钥、远程同意、URL 校验、脱敏、预算和结构化输出。
- 交付路径、符号链接、哈希与独立验收。
- CLI/MCP/Skill 的确认和下载边界。

## 已实现的控制

| 控制 | 实现 | 证据 |
|---|---|---|
| 显式契约批准 | `submitAnswers` 要求授权与批准标志 | `packages/autopilot/src/engine.ts` |
| 默认 local-only | 契约数据共享默认本地；远程需单独问题/同意 | `engine.ts`、`questions.ts` |
| 禁止操作 | 任意 shell、未知代码、越界写入、外传等写入契约 | `engine.ts` |
| 工具权限 | 注册工具权限与调用上下文逐项核对 | `tools.ts` |
| cwd 隔离 | cwd 必须是任务工作区子目录 | `assertIsolatedCwd` |
| 命令 allowlist | 仅 npm run build/test/package，shell=false | `runAllowlistedCommand` |
| 租约与 fencing | 领取租约、有效期检查、结果发布前再次检查 | `engine.ts` |
| 输入边界 | 提示词 16000、答案 128 字段/500KB、数组上限 | `autopilot-routes.ts` |
| 工件完整性 | 登记大小/SHA-256，下载前 snapshot 校验 | `autopilot-routes.ts` |
| 符号链接拒绝 | 交付遍历拒绝链接，工件下载再校验 | `delivery.ts` |
| 模型密钥 | SecretStore 引用、只写不返显、错误脱敏 | `providers.ts`、`model-routes.ts` |
| Provider 预算结算 | Token 累计不重置；非法 usage 拒绝；缺失 usage 保守结算；成本按每百万 Token 正确换算 | `packages/autopilot/src/providers.ts`、`tests/unit/model-providers.test.ts` |
| 远程模型边界 | HTTPS、显式同意、safeFetch、禁止重定向 | `model-routes.ts` |
| MCP 最小暴露 | 不暴露清理、设备打开、刷写、任意命令 | `apps/cli/src/tools.ts` |
| MCP 下载写入 | 默认不写盘；显式 destination 仅限 stdio 允许根，拒绝越界/symlink/覆盖，`wx` 独占创建 | `apps/cli/src/tools.ts`、`tests/unit/mcp-download-safety.test.ts` |
| MCP 下载边界 | 默认不写盘；显式 destination 仅允许根目录内独占创建，拒绝符号链接与 HTTP 保存 | `apps/cli/src/tools.ts`、`tests/unit/mcp-download-safety.test.ts` |
| API 路径脱敏 | 任务选项、证据 source/locator/content、SSE 与事件历史递归移除本机绝对路径；Legacy 公开分析仅保留 basename | `apps/api/src/security.ts`、`apps/api/src/server.ts`、`tests/integration/api-safety.test.ts` |
| 租约续期 | Autopilot run/deliver 使用 CAS heartbeat，续租失败立即中止且禁止成功 | `packages/autopilot/src/engine.ts`、`tests/unit/autopilot.test.ts` |

## 测试证据

2026-11-27 Windows 冻结定向回归已实际运行：Autopilot 28/28、Provider 单元/API 21/21、Workflow 95/95、Planner 36/36、Agent 安全 30/30、Autopilot API 8/8、MCP 下载安全 8/8、发行工作流 16/16、OpenAPI 3/3。覆盖未授权阻塞、幂等冲突、项目隔离、工具权限、cwd 越界、租约续期/恢复、工件篡改、SSE、Provider 预算/脱敏/结构化输出、MCP 文件写入边界与发行门禁。详见 [V008-TEST-RESULTS.md](V008-TEST-RESULTS.md)。

冻结复审追加问题的定向回归已单独运行：`autopilot.test.ts`、`model-providers.test.ts`、`model-providers-api.test.ts`、`mcp-download-safety.test.ts`、`release-workflows.test.ts`、`openapi-contract.test.ts`、`autopilot-api.test.ts` 共 **7 files / 84 tests passed**。覆盖长任务与交付续租、周期恢复、暂停恢复、输入锁定、Provider 累计/成本/非法与缺失 usage、MCP 任意路径写、OpenAPI 历史不可变及 CLI/MCP 契约批准。逐项证据见 [V008 缺陷登记](V008-DEFECT-REGISTER.md)。

这些定向测试不是完整安全审计，也不等于全量冻结门禁通过；不得据此宣称所有 P0/P1 风险已清零。

## 待独立复审风险

| 项目 | 状态 | 要求 |
|---|---|---|
| 提示词注入与目标材料对抗 | UNVERIFIED | 用恶意网页/日志/文件内容测试，确认不能改授权、工具或预算 |
| 多进程租约与 SQLite 并发 | PARTIAL | 续租、周期恢复、暂停恢复与 fencing 已有定向回归；多进程崩溃/重复执行压力测试仍待完成 |
| 大型工件与磁盘耗尽 | UNVERIFIED | maxDiskMB 的实际执行与跨平台行为 |
| 子进程树清理 | UNVERIFIED | Windows/Linux 超时、取消、孙进程退出 |
| 远程模型数据最小化 | UNVERIFIED | 审查实际请求体、日志和交付包是否含敏感材料 |
| SSRF/DNS rebinding | UNVERIFIED | 独立测试 website/security/model 端点 |
| 跨平台路径与保留名 | PARTIAL | Windows 有测试；Ubuntu/ macOS 待回归 |
| SecretStore 静态加密与文件权限 | UNVERIFIED | 检查 `secret.key` 权限、备份与轮换 |
| MCP HTTP 响应与下载限制 | PARTIAL | 5 MiB 限制已实现；真实客户端待测 |
| 安装包/升级供应链 | UNVERIFIED | 固定版本资产、签名、provenance 与回滚演练 |

## 独立冻结复审

2026-11-27 独立只读复审结论已完整收到：**P0=0、P1=0，可进入冻结**。复审覆盖 Autopilot 租约/恢复/输入锁定、Provider 预算与用量、MCP 下载边界、CLI/MCP 计划批准、发行工作流版本门禁等；对应修复与定向回归已登记在 `V008-DEFECT-REGISTER.md`。复审成员最后一次回传发生网络超时，但结论内容已完整接收，不将传输失败伪装成额外通过证据。

剩余 P2：

- V008-003：真实远程模型 Key E2E 受外部凭证阻塞，保持 OPEN / BLOCKED。
- V007-007：历史性能 JSON 来源不可核验，不得作为发行性能证据。
- V008-016：Provider 成本单位问题已修复并登记，定向回归通过。
- V008-020 至 V008-023：候选阶段发现的跨平台 ZIP、E2E 选择器、Windows 等待与 Server 打包问题均已修复并验证。

## 发行门禁

- 独立复审达到 P0=0、P1=0；全量测试、E2E、候选资产验收与公开复验均通过。
- 冻结复审及候选阶段发现的问题已逐项登记于 `V008-DEFECT-REGISTER.md`，状态以该表与实际证据为准。
- V008-003（真实远程模型 E2E）为 OPEN P2 外部凭证阻塞；未获得 Key 前不得宣称真实模型自主执行已验证。
- v0.0.8 正式发行 Run `45994026211` 已通过；15 个公开资产完成 SHA-256 与公开地址复验。
- 发现新的高危问题应停止后续候选发布，保留上一稳定版；已公开资产不得静默覆盖。
