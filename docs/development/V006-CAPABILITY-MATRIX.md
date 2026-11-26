# V006 能力矩阵

更新：2026-11-26。状态：IMPLEMENTED / PARTIAL / BLOCKED / UNKNOWN / NOT_IMPLEMENTED。

| 能力 | v0.0.5 基线 | v0.0.6 目标 | 当前状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| 协议/状态兼容分析 | 单会话、固定观察模板 | 保留并明确非多人恢复 | IMPLEMENTED | `game` adapter 112 项安全回归；platform integration |
| L0-L7 证据等级 | 仅 L4 | 独立指标与真实测试推进 | IMPLEMENTED | `validationLevel()` 只读结构化报告；本地 FPS/RPG 最高 L6，正式 v0.0.6 候选 CI 的 Docker 验收已达到 L7 |
| 大型游戏目录 | 上传单文件 | 本机只读、增量、流式指纹 | IMPLEMENTED | scanner 身份/四元元数据校验、读取硬上限、skipped≤100、RE_GAME_ROOTS 强制白名单 |
| Game Server Specification | 无统一规格 | 证据分级与模块选择 | IMPLEMENTED | observation 服务端校验；客户端最高 INFERRED；无证据 UNKNOWN；无文件保持 L0 |
| 独立 TypeScript 服务端工程 | 单 server.mjs | 完整源码/数据库/后台/部署 | IMPLEMENTED | 生成工程真实 `npm ci/build/test`；FPS/RPG 独立启动 |
| 多玩家同场 | 未实现 | ≥2 真实客户端、权威状态 | IMPLEMENTED | FPS/RPG 4 客户端同场、动作、结算；2/8/16/32/64 基准 |
| 多房间并发 | 未实现 | 状态隔离、并发房间 | IMPLEMENTED | 双房间隔离、房间配额、空房间 TTL、64 客户端基准 |
| 断线重连 | 未实现 | resume token、状态恢复 | IMPLEMENTED | resume 轮换、旧连接吊销、重放回归 |
| 持久化与重启恢复 | 单账号 JSON | 账号/角色/对局持久化 | IMPLEMENTED | FPS/RPG 重启恢复；持久化失败健康检查 503；shutdown flush |
| 管理后台 | 无独立后台 | 认证、权限、审计、真实指标 | IMPLEMENTED | Bearer Token、401、统计、审计；后台相对路径 |
| Docker Compose | 无生成物 | 实跑 build/up/health | VERIFIED | 本地未运行；v0.0.6 正式候选 Release Run `45792899427` 的 FPS/RPG Docker build/up/health/cleanup 全部通过 |
| AI 重建工作流 | 分析建议 | 可选、有界、Schema 校验 | PARTIAL | 复用 AI V3；不默认依赖，不把模型文本作为事实 |
| 原始商业客户端兼容 | 无 | 仅授权与证据充分时 | BLOCKED | 无样本/授权；CODOL 2021 研究档案记录缺口 |
| CODOL 2021 | 无专项 | 研究档案与缺口 | IMPLEMENTED | `docs/user-guide/CODOL-2021-RESEARCH.md` |
| 自有多人游戏 L7 | 无 | 至少一个 | VERIFIED | v0.0.6 正式候选 CI 的 FPS/RPG Docker 部署证据通过；仅证明自有多人生成服务部署，不证明商业原客户端兼容 |
| Windows EXE | v0.0.5 | 安装/启动/退出审计 | IMPLEMENTED | v0.0.6 NSIS 静默安装退出 0；`--smoke-test` 含真实 Game Revival 重建；npm 运行时闭包 290 包 |
| 全入口同步 | Web/CLI/MCP/Skill | API/CLI/MCP/Web/Skill/Docker | IMPLEMENTED | 44 MCP 工具、6 个 game 子命令、OpenAPI v0.0.6、Skill 文档同步 |

禁止把文件生成、测试数量或 mini hello/login 流程当作 L5-L7。Docker 未实跑时最高为 L6；v0.0.6 的 L7 仅来自正式候选 CI 实跑，商业原客户端兼容性默认 UNKNOWN。
