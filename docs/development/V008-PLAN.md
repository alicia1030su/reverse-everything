# v0.0.8 Autopilot 开发计划

## 架构决策

- 新增 `@reverse/autopilot` 作为统一智能调度层，复用 `@reverse/workflow`、`@reverse/planner`、`@reverse/evidence` 与现有分析器。
- Schema 7 新增 Autopilot 任务、消息和步骤结果表；旧任务与 API 保持兼容。
- 默认规则型执行；模型仅提供经过 Schema 校验的建议，不能直接执行命令或扩大授权。
- 本地优先、默认 `local-only`；远程 AI 需独立授权。
- 重型构建串行，工具调用统一预算，未知生成代码只在受控工作区运行。

## 阶段

- [x] 核实 v0.0.7 正式发行源并恢复冻结工作树。
- [x] Phase 0：全量测试、独立审计、历史缺陷登记。
- [x] Phase 1-11：Autopilot 核心、对话、契约、规划、持久化、智能体、Provider、工具与证据。
- [x] Phase 12-20：成品生成、修复闭环、独立验收、交付、教程、可视化、干预、记忆与大文件。
- [x] Phase 21-24：产品化 UI、全入口、内存优化与安全审计。
- [x] Phase 25-28：真实黑盒场景、指标、README、全量回归与独立复审。
- [x] Phase 29-30：候选资产验收、原子正式发行与最终报告。

## 质量门禁

- P0=0、P1=0；可安全修复的 P2 一并处理。
- 保留 782 项历史通过与 9 项跳过映射，不删除测试。
- 新增 Autopilot 全流程、恢复、权限、交付独立性测试。
- 真实模型能力必须与 Mock/规则型明确区分。
- Tag Commit = Build Commit = Acceptance Commit。
