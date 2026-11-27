# Autopilot：自然语言目标到可核验交付

> v0.0.8 开发文档。源码版本已同步为 v0.0.8，但尚未正式发布或完成全部能力验收；当前稳定版仍为 v0.0.7。

## 1. 它是什么

Autopilot 是统一调度层：接收自然语言目标，识别类型，动态追问缺少的信息，生成**目标契约**和**有依赖关系的计划**，在授权与预算内复用真实分析器、本地构建工具，最后生成带 SHA-256 和独立规则验收的交付包。

入口：

- Web：`/`、`/autopilot`、`/autopilot/:id`、`/delivery`、`/models`。
- REST：`/api/autopilot/*`、`/api/models/*`。
- CLI：`reverse-everything autopilot ...`。
- MCP：`autopilot_create` 等 10 个工具。
- Skill：`skills/reverse-everything`，优先调用 MCP。

## 2. 三种执行证据，不要混淆

| 类型 | 当前实现 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 规则型 | `detectIntent`、`createAutopilotPlan`、默认工具注册表 | 意图分类、计划依赖、真实工具执行与规则验收 | 不能证明模型理解能力或远程 AI 可用 |
| Mock / fixture | 单元与集成测试中的测试 adapter、模拟 HTTP 响应 | 控制流、错误分支、预算与脱敏逻辑 | 不能证明真实模型、真实网站或商业客户端兼容 |
| 真实模型 | V4 Provider API 与能力探测 | 保存真实配置、实际 HTTP 探测、调用结果与用量 | 当前 Autopilot 引擎尚未把模型接入意图/规划主链路；真实远程 Key E2E 为 `UNVERIFIED` |

默认执行是规则型、`local-only`。模型管理页存在，不等于 Autopilot 已由真实模型自主决策。

## 3. 一次完整任务

1. **描述目标**：在首页输入目标，可附上传文件、绝对路径或 URL。
2. **补齐需求**：系统只询问缺失字段，例如材料、平台、授权；已回答字段不应重复询问。
3. **确认目标契约**：检查授权范围、允许/禁止操作、预算、数据共享与验收标准。
4. **确认执行计划**：检查步骤、工具、依赖、预期输出和逐步验收条件。
5. **真实执行**：服务端轮询领取已批准计划；分析步骤创建并等待真实子工作流终态。
6. **交付**：部署类目标包含 reconstruct → build → test → package → document → verify；分析类目标通常为 analyze → document → verify。
7. **下载与复核**：在交付中心查看工件、教程、验收检查与 SHA-256。

只有显式批准契约和计划后才开始执行。不得代替用户自动确认。

## 4. 状态与操作

| 状态组 | 含义 | 用户操作 |
|---|---|---|
| `WAITING_FOR_USER` | 缺少必要信息 | 回答问题或补充材料 |
| `WAITING_FOR_APPROVAL` | 等待契约或计划确认 | 阅读后显式确认 |
| `PLANNING` / `RUNNING` / `REPAIRING` | 活跃执行 | 可暂停、取消 |
| `PAUSED` | 在检查点暂停 | 恢复后复用成功步骤 |
| `COMPLETED` | 独立规则验收为 `DELIVERABLE_VERIFIED` | 打开交付中心 |
| `PARTIAL_SUCCESS` | 有交付但未完全通过 | 阅读未完成项，不得宣称完整交付 |
| `FAILED` / `BLOCKED` / `CANCELLED` | 未完成 | 查看真实错误；修正输入后创建新任务 |

暂停/恢复不是回滚。取消不会删除已生成工件。终态任务不能靠重复提交答案“重启”。

## 5. 默认安全边界

- 默认 `local-only`；远程模型数据共享必须独立授权。
- 禁止任意 shell、未知代码执行、任务工作区外写入、网络外传、未授权远程模型和修改原始输入。
- 分析器仅消费已授权目标；URL 仍受 SSRF 与本地目标确认限制。
- 非 Web 构建只允许隔离 cwd 内 `npm run build`、`npm run test`、`npm run package`，使用 `--if-present`。
- 交付下载只服务已登记工件，并在发送前核对大小与 SHA-256。
- 模型输出只能是建议或 `INFERENCE`，不能替代工具证据、用户授权或独立验收。

## 6. 真实限制

- 真实远程模型端到端任务验收尚未完成；无 Key 时不得用 Mock 冒充。
- 自动修复当前主要是 build/test 步骤的有限重试，不等于模型驱动的自主重规划。
- 长期项目记忆、完整多智能体协作、跨任务知识检索不在当前可宣称范围内。
- 规则型意图识别会误判；目标、平台和材料必须由用户复核。
- 静态站点生成是独立候选站点，不保证复刻目标设计、业务逻辑或第三方资源。
- 非 Web 工程若没有可信源码，只会生成诚实的工程交接/构建计划，不会伪造可运行成品。
- 本机绝对路径仍受对应分析器的目录白名单与 API 服务端配置限制。
- 大文件、物理设备、外部商业客户端和跨平台安装包验收需独立证据。

## 7. 相关文档

- [新手快速开始](BEGINNER-QUICKSTART.md)
- [模型配置](MODEL-SETUP.md)
- [任务恢复与排障](TASK-RECOVERY.md)
- [工件交付](ARTIFACT-DELIVERY.md)
- [AI 权限](AI-PERMISSIONS.md)
- [本地代理与自动化](LOCAL-AGENT.md)
- [开发设计](development/V008-AUTOPILOT-DESIGN.md)
