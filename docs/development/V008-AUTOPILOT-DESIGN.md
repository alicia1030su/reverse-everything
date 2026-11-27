# v0.0.8 Autopilot 产品定义与设计

> 状态：v0.0.8 已正式发布。基于冻结 Commit `d2334ee267098e30f44b72c80f975e520abbc47c`；未完成项保持 `PARTIAL` 或 `UNVERIFIED`。

## 1. 背景

v0.0.7 已具备真实分析器、持久化工作流、证据和恢复基础，但自然语言入口仍是固定向导，分析报告不等于可运行交付。v0.0.8 新增 Autopilot，把授权目标、动态需求、目标契约、依赖计划、真实工具执行和独立验收串成可追溯闭环。

目标用户为拥有合法材料的本地用户、兼容重建研究者和通过 CLI/MCP/Skill 使用本地 Agent 的进阶用户。默认本地运行，不要求远程模型 Key。

## 2. 目标与度量

- **业务目标**：用户能用自然语言完成一次“目标 → 授权 → 计划 → 执行 → 可核验交付”。
- **北极星指标**：完成独立规则验收的 Autopilot 交付任务数。
- **成功度量**：以 `autopilot_tasks.status='COMPLETED'` 且 `reports/ACCEPTANCE.json` 为 `DELIVERABLE_VERIFIED` 计数；数据源为 SQLite 和交付报告。
- **质量度量**：重复提问数、无进展熔断数、失败步骤真实错误率、交付哈希复核通过率。
- **当前口径**：指标主要从真实事件和持久化结果读取；模型调用指标当前通常为 0。

目标值待真实黑盒验收后冻结，不预先宣称提升比例。

## 3. 用户故事

| ID | 角色与场景 | 优先级 | 验收标准 |
|---|---|---|---|
| US-01 | 用户用自然语言描述合法静态网站目标 | P0 | 返回意图、缺失问题和任务 ID；不自动执行 |
| US-02 | 用户补充材料、平台与授权 | P0 | 已回答字段不重复询问；未授权不创建计划 |
| US-03 | 用户确认契约与计划 | P0 | 两次确认均显式；批准前状态为等待确认 |
| US-04 | 系统执行真实分析与本地工具 | P0 | 子任务有真实终态；步骤结果持久化 |
| US-05 | 用户暂停、恢复或取消 | P0 | 成功步骤复用；状态版本递增；取消不删工件 |
| US-06 | 用户下载交付并复核 | P0 | 清单、教程、验收和 SHA-256 齐全；篡改下载被拒绝 |
| US-07 | 用户配置本地/远程模型 | P1 | Key 不返显；远程需同意；能力仅按探测结果更新 |
| US-08 | Agent 通过 MCP/Skill 调用 | P1 | 不代用户确认；不编造进度；下载受限 |
| US-09 | 用户查看失败原因并重试 | P1 | 错误可追溯到具体步骤；熔断不伪造成功 |
| US-10 | 用户进行真实远程模型验收 | P1 | 有真实 Key、端点、任务、用量与结果；当前 `UNVERIFIED` |

## 4. 功能清单

| 编号 | 功能 | 描述 | 优先级 | 端 | 故事 |
|---|---|---|---|---|---|
| F-01 | 自然语言创建 | 目标、上传、路径、URL、幂等键 | P0 | Web/API/CLI/MCP | US-01 |
| F-02 | 动态需求发现 | 只询问缺失字段，合并答案 | P0 | 全入口 | US-02 |
| F-03 | 目标契约 | 授权、预算、数据边界、验收 | P0 | 全入口 | US-03 |
| F-04 | 动态依赖计划 | 按意图生成 DAG 并校验环 | P0 | 核心 | US-03 |
| F-05 | 持久执行 | 租约、checkpoint、步骤幂等 | P0 | 核心 | US-04 |
| F-06 | 真实分析器复用 | 子工作流终态与工件采集 | P0 | 核心 | US-04 |
| F-07 | 本地交付工具 | 静态站点、allowlist 构建、测试、打包 | P0 | 核心 | US-04 |
| F-08 | 独立验收 | 规则检查、manifest、哈希、教程 | P0 | 核心/Web | US-06 |
| F-09 | 干预控制 | 暂停、恢复、取消 | P0 | Web/API/CLI/MCP | US-05 |
| F-10 | Provider V4 | 多角色、能力探测、预算、故障切换 | P1 | Web/API | US-07 |
| F-11 | 事件与消息 | 持久化消息、SSE、轮询降级 | P1 | Web/API/CLI | US-04 |
| F-12 | 交付中心 | 文件、验收、教程、指标 | P1 | Web | US-06 |
| F-13 | 真实模型闭环 | 模型意图/规划进入主链 | P1 | 核心 | US-10 |
| F-14 | 长期记忆与多智能体 | 跨任务上下文与角色隔离 | P2 | 核心 | — |

P0 为 9/14。F-13 真实模型主链集成保持 BLOCKED（V008-003）；F-14 长期记忆与完整多智能体为 PARTIAL，不得标记完成。

## 5. 核心流程与异常分支

### 5.1 创建到交付

```text
自然语言目标
  → 规则识别 / 提取 URL 与路径
  → 缺失信息？ ─是→ WAITING_FOR_USER → 用户回答 → 重新计算问题
  │ 否
  → 生成目标契约
  → 用户批准契约？ ─否→ WAITING_FOR_APPROVAL
  │ 是
  → 生成并校验计划
  → 用户批准计划？ ─否→ WAITING_FOR_APPROVAL
  │ 是
  → PLANNING → 领取租约 → RUNNING
  → 执行首个依赖就绪步骤
       ├ 成功 → 持久化结果 → 下一步
       ├ 可修复失败 → REPAIRING → 预算内重试
       └ 不可修复 / 熔断 → FAILED
  → 所有步骤成功 → 生成交付包 → 独立规则验收
       ├ 全部通过 → COMPLETED
       └ 部分通过 → PARTIAL_SUCCESS
```

### 5.2 异常出口

- 未授权：`BLOCKED`，不生成计划或子任务。
- 输入缺失：停留 `WAITING_FOR_USER`，给出具体问题。
- 计划未确认：停留 `WAITING_FOR_APPROVAL`，不领取执行。
- 子任务失败：记录真实终态，不把 Mock 当成功。
- 租约过期：恢复到 `PLANNING`/`PAUSED`，复用成功步骤。
- 无进展：触发熔断并保留错误。
- 工件变化：下载完整性检查失败，拒绝发送。
- 远程模型未同意：403，不回退为静默上传。

## 6. 数据与页面

核心实体：`autopilot_tasks`、`autopilot_messages`、`autopilot_step_results`、`autopilot_artifacts`。任务保存 intent/questions/answers/contract/plan/checkpoint/metrics/lease；步骤结果保存真实输出、检查与错误；工件保存名称、路径、大小、SHA-256 与 MIME。

| 页面 | 路径 | 四态设计 |
|---|---|---|
| Autopilot 首页 | `/autopilot` | 空态：无任务；加载：项目/列表；错误：创建失败；无权限：沿用后端授权错误 |
| 任务详情 | `/autopilot/:id` | 空态：不存在；加载：同步；错误：步骤错误；无权限：越权访问拒绝 |
| 交付中心 | `/delivery`、`/delivery/:id` | 空态：无工件；加载：读取；错误：下载/验收失败；无权限：令牌/项目边界 |
| 模型管理 | `/models` | 空态：无 Provider；加载：配置读取；错误：API 不可用回退；无权限：远程同意缺失 |

## 7. 验收标准与范围

### P0 验收

- 创建请求幂等；同键不同请求返回冲突。
- 动态问题不重复已回答字段；未授权任务被阻塞。
- 计划依赖存在且无环；部署目标包含 build/test/package/document/verify。
- 真实子任务终态和步骤结果持久化；崩溃恢复不重复成功步骤。
- 暂停/恢复/取消状态正确，状态版本递增。
- 交付包含五类必需文件，工件哈希可复核，reviewer 为 `independent-rules`。
- API 认证、项目隔离、工件篡改拒绝和结构化错误通过测试。

### 非本期范围

- 不保证复刻任何商业软件、游戏原客户端或原服务端。
- 不绕过登录、DRM、反作弊、许可或访问控制。
- 不提供任意宿主机 shell、设备写入、刷写或驱动安装。
- 不宣称真实远程模型、多智能体、长期记忆或所有平台兼容已完成。

## 8. 当前实现证据

- 核心：`packages/autopilot/src/engine.ts`、`planner.ts`、`tools.ts`、`delivery.ts`。
- API：`apps/api/src/autopilot-routes.ts`、`model-routes.ts`。
- Web：`apps/web/src/pages/Autopilot.tsx`、`DeliveryCenter.tsx`、`ModelManager.tsx`。
- 入口：`apps/cli/src/cli.ts`、`apps/cli/src/tools.ts`、`skills/reverse-everything/SKILL.md`。
- 定向与分平台测试：Ubuntu 906 passed / 7 skipped，Windows 905 passed / 8 skipped，完整 E2E 32/32；正式候选 `45986134905`、发行 `45994026211` 均通过。详见 [V008-TEST-RESULTS.md](V008-TEST-RESULTS.md)。
