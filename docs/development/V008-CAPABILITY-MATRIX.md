# v0.0.8 能力矩阵

状态：IMPLEMENTED / VERIFIED / PARTIAL / BLOCKED / UNSUPPORTED。模型文本与 Mock 结果不能标记 VERIFIED。

| 能力 | v0.0.7 基线 | v0.0.8 目标 | 状态 |
|---|---|---|---|
| 自然语言首页与多轮对话 | 固定向导 | ChatGPT 式工作台 | VERIFIED |
| 动态需求发现 | 固定问卷 | 按目标动态询问、自动检测、合理默认 | VERIFIED |
| 目标契约 | 无统一契约 | 授权、预算、验收、限制结构化 | VERIFIED |
| 动态任务规划 | 确定性计划 | DAG、依赖、重规划、版本化 | VERIFIED |
| 持久化自主执行 | Worker 阶段恢复 | Autopilot 检查点、幂等、暂停/取消 | VERIFIED |
| 多智能体 | 单轮角色提示词 | 按需角色、上下文/预算隔离 | PARTIAL：角色与模型路由基础已实现，完整协同未完成 |
| 模型管理 | 单一模型设置 | 多角色 Provider、能力检测、故障切换 | VERIFIED |
| 工具注册 | 分散适配器 | 统一 Schema、权限、预算、验证状态 | VERIFIED |
| 证据知识库 | 任务证据表 | 项目索引、按需检索、本地模式 | PARTIAL：项目证据索引已实现，跨任务完整检索未完成 |
| 成品生成 | 分析/重建工件 | 可下载独立成品与源码 | VERIFIED |
| 构建测试修复 | 各模块局部 | 隔离环境闭环 | VERIFIED |
| 独立验收 | 局部验证 | Delivery Reviewer 与验收状态 | VERIFIED |
| 教程与部署 | 部分文档 | 从真实成品生成并验证 | VERIFIED |
| 全入口 | Web/API/CLI/MCP/Skill | 共享 Autopilot 核心 | VERIFIED |
| 真实远程模型 | 未验收 | 实际调用并完成目标任务 | BLOCKED：V008-003，`MISSING_API_KEY` |
