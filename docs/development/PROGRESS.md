# 开发进度

最后更新：2026-11-24（UTC+8）

## 项目档案

- 项目：逆向万物 Reverse Everything
- 定位：本地单用户、证据驱动的逆向与兼容重建工作台
- 仓库：`alicia1030su/reverse-everything`（Public，已创建）
- 版本：v0.0.1
- 技术栈：TypeScript、React/Vite、Fastify、Node 22、SQLite、Playwright、npm workspaces
- 当前阶段：Phase 12 综合验收与发布
- 架构决策：模块化单体 API + 独立 Worker；默认 AI 关闭；本地令牌；证据四分类；规则型兼容服务
- 里程碑：本地功能与测试 → GitHub CI（含 Docker）→ main → v0.0.1 Tag/Release

## Phase 状态

| Phase | 状态 | 交付 / 证据 |
|---|---|---|
| 0 环境审计与规划 | 完成 | PRD、ARCHITECTURE、SECURITY-MODEL、ROADMAP、REA 对照、插件规范 |
| 1 初始化项目 | 完成 | npm workspaces、共享类型、ESLint/TS/Vitest、CI、环境模板、许可证 |
| 2 基础任务系统 | 完成 | SQLite 队列、状态机、哈希、日志、恢复、缓存检查点、SSE |
| 3 Web 控制台 | 完成 | 真实 API 页面、暗色响应式 UI、E2E |
| 4 统一插件引擎 | 完成 | Adapter 契约、注册表、故障隔离、四个适配器 |
| 5 网页 MVP | 完成 | 自编写站点真实采集，截图/DOM/NDJSON/报告 |
| 6 文件/二进制 MVP | 完成（基础范围） | PE/ELF/Mach-O、字符串、ZIP、SBOM；Ghidra 不在本版本 |
| 7 AI MVP | 完成 | OpenAI 兼容配置、加密密钥、模拟 provider 实测、无 Key 回退 |
| 8 游戏复活 MVP | 完成（L3 演示） | 真实回放、协议推断、生成服务、E2E |
| 9 安全 MVP | 完成（基础范围） | 被动头检查、静态规则、正常样本误报检查、SARIF |
| 10 重建与验证 | 部分完成 | 游戏兼容服务已导出；网页克隆/多页面重建不在 v0.0.1 |
| 11 CLI/MCP/Skill | 部分完成 | CLI/MCP 已完成；独立 Skill 包未发布，使用说明已提供 |
| 12 验收与发布 | 进行中 | 本地门禁、依赖/秘密/许可证检查、GitHub CI 与 Docker、正式 Release |

## 已完成产出

- 可构建 Monorepo 与生产 Web 静态资源。
- 15 项单元测试、8 项真实集成场景、2 项浏览器 E2E，共 23 项非浏览器测试 + 2 项 E2E 全部通过。
- 演示网站与自编写迷你游戏、真实协议样本。
- Dockerfile/Compose、Windows/Ubuntu CI、Tag Release 工作流。

## 下一步

1. 完成最终全量复验与性能实测。
2. 检查生产依赖许可证和高危公告。
3. 初始化 Git、创建 Public 仓库并推送，观察 CI。
4. 仅在 CI（含 Docker build/run）通过后合并/标记/发布 v0.0.1。
5. 记录 Release URL、Commit SHA、产物 SHA-256 与未支持功能。
