# 逆向万物 v0.0.1

首个可验证的本地逆向工程工作台。

## 新增

- React 深色 Web 控制台，全部统计与任务状态来自真实 API。
- Fastify REST API、SQLite 持久任务、独立 Worker、SSE 断线恢复。
- 项目授权、上传哈希、阶段暂停/恢复/取消/重试。
- Playwright 同源网页采集：DOM、脚本、路由候选、截图、网络元数据。
- PE/ELF/Mach-O 静态元数据、section/import、熵、有界字符串、ZIP 安全清单、SBOM。
- 被动 HTTP 安全检查、静态 CWE 候选、Markdown/JSON/SARIF 报告。
- OpenAI 兼容模型配置、Ollama、AES-256-GCM 密钥加密、INFERENCE 证据标记。
- 自编写迷你游戏真实回放推断、独立兼容服务生成与 E2E 验证。
- CLI 与 stdio MCP 基础工具。
- Dockerfile、Docker Compose、Windows/Ubuntu CI、完整文档。

## 验证

- 单元、真实 Worker 集成、浏览器 E2E 与 Docker job 为发布门禁。
- 具体命令、样本和结果见仓库 `docs/development/TEST-RESULTS.md` 与 Actions run。

## 限制

- 不含 Ghidra 反编译、调用图、APK/DEX 解码、HAR/PCAP 导入、多页面状态机、网站克隆、iOS 深度分析或分布式 Worker。
- 游戏兼容服务仅回放已观察响应模板，不是原始服务端恢复。
- 安全规则产生复核候选，不自动确认或利用漏洞。
- 只可分析合法授权目标，不得绕过访问控制或分发未授权资源。

## 升级

这是首个正式版本，无升级迁移要求。数据位于本地 `data/` 或 Docker 命名卷。
