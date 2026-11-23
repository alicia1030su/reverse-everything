# 逆向万物 · Reverse Everything

**AI 自动化逆向工程与数字软件兼容重建工作台**

[![CI](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

逆向万物把授权目标转化为可追溯的分析任务：真实工具证据、持久化阶段、可恢复状态、可重复验证和可下载产物。它不是反编译器数量排行榜，也不承诺无条件恢复所有软件。

> 仅分析你拥有或明确获授权的目标。不得绕过登录、验证码、付费、DRM、反作弊或访问控制。

## v0.0.1 已实现

| 能力 | 实际范围 |
|---|---|
| Web 控制台 | 总览、创建项目、任务工作台、证据图、协议、复活、安全、验证、设置 |
| 持久任务 | SQLite、阶段检查点、暂停/恢复/取消/重试、SSE 断线序号 |
| 网页分析 | Playwright DOM、脚本、路由候选、表单、截图、同源网络 NDJSON |
| 文件分析 | PE/ELF/Mach-O 元数据、section/import、熵、有界字符串、ZIP 清单、SBOM |
| 安全分析 | 被动 HTTP 头/Cookie/CORS 检查、静态 CWE 规则、Markdown/JSON/SARIF |
| AI 配置 | OpenAI 兼容端点、Ollama、加密 API Key、远程数据同意、INFERENCE 标记 |
| 游戏复活演示 | 真实回放推断、独立 WebSocket 兼容服务生成、E2E 验证 |
| 自动化入口 | CLI、stdio MCP（8 个基础工具）、同一 REST 契约 |
| 部署 | Dockerfile、Docker Compose、GitHub Actions |

**未实现/不支持**：Ghidra 反编译、调用图、APK/DEX 解码、HAR/PCAP 导入、多页面状态机、网站克隆、iOS 深度分析、分布式 Worker、自动漏洞利用。见 [路线图](docs/ROADMAP.md)。

## 快速开始

要求：Node.js **22.13+**、npm、Git。网页分析需要 Chrome/Chromium。

```bash
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4173>。API 与 Web 同端口；启动时生成 `data/local-token`，不要在公开仓库提交 `data/`。

开发时只启动 API 与独立 Worker，不额外启动 Vite：

```bash
npm run dev
```

## Docker

```bash
docker compose up -d --build
curl http://127.0.0.1:4173/api/health
```

宿主端口只绑定 `127.0.0.1`；数据保存在 `reverse-everything-data` 卷。

```bash
docker compose logs -f
docker compose down          # 保留数据
docker compose down -v       # 删除数据卷
```

## 创建第一个任务

1. 打开“新建分析”，选择网页、软件、游戏复活或安全分析。
2. 输入 URL 或选择文件。
3. 确认合法授权；本地演示 URL 需额外勾选本地权限。
4. 创建后在任务工作台查看真实阶段、日志、证据和产物。
5. 下载 `report.md`、`findings.sarif`、`manifest.json` 或重建文件。

未配置 AI 时，所有基础规则分析仍可运行。AI 文本始终标为 `INFERENCE`，不能替代工具证据。

## 真实演示

### 网页

```bash
node examples/demo-website/server.mjs
```

在 Web 控制台输入 `http://127.0.0.1:3100`，勾选本地演示权限并创建“逆向网页”任务。验收产物：`page.png`、`dom.html`、`network.ndjson`、`web-analysis.json`。

### 游戏复活

```bash
node examples/demo-game/capture.mjs
```

脚本启动本项目自编写的原始服务，录制 hello/login/move/logout 到 `examples/demo-game/captured-trace.json`，然后停止原服务。上传该记录创建“复活游戏”任务。

平台会推断字段与状态转换，生成 `server.mjs`，启动独立兼容服务并验证完整流程。生成服务只回放已观察响应模板，**不是原始服务端恢复**。详见 [演示说明](examples/demo-game/README.md)。

## CLI

```bash
node apps/cli/dist/cli.js health
node apps/cli/dist/cli.js projects list
node apps/cli/dist/cli.js projects create "我的授权样本" software --authorized
node apps/cli/dist/cli.js projects upload <projectId> ./sample.json
node apps/cli/dist/cli.js tasks create <projectId> file
node apps/cli/dist/cli.js tasks get <taskId>
node apps/cli/dist/cli.js tasks report <taskId> ./report.md
```

默认读取 `data/local-token`。可用 `RE_API_URL`、`RE_API_TOKEN`、`RE_DATA_DIR` 覆盖。

## MCP

MCP server 通过 stdio 与 Web/CLI 共用 API：

```json
{
  "mcpServers": {
    "reverse-everything": {
      "command": "node",
      "args": ["C:/absolute/path/reverse-everything/apps/cli/dist/mcp.js"],
      "env": {
        "RE_API_URL": "http://127.0.0.1:4173",
        "RE_DATA_DIR": "C:/absolute/path/reverse-everything/data"
      }
    }
  }
}
```

工具：`list_projects`、`create_project`、`upload_file`、`create_task`、`list_tasks`、`get_task`、`task_action`、`get_report`。

## 证据模型

- `EVIDENCE`：实际工具输出。
- `INFERENCE`：规则或模型推断，必须可追溯。
- `UNKNOWN`：证据缺失，不伪装成结论。
- `VERIFIED`：通过可重复测试的结论。

所有主要证据包含 source、locator 与 SHA-256；导出 manifest 记录输入哈希、工具版本、阶段和产物哈希。

## 安全

- 本地令牌 + Host/Origin 校验；默认仅 loopback。
- SSRF、私网、metadata、DNS 重绑定与重定向防护。
- ZIP 路径穿越/压缩炸弹/条目上限。
- 不执行未知上传程序；浏览器仅同源采集。
- API Key AES-256-GCM 加密；日志与证据脱敏。
- 外部内容和模型输出不能授予工具权限。

完整边界见 [安全模型](docs/SECURITY-MODEL.md)。

## 测试

```bash
npm run typecheck
npm run lint
npm test                # 单元 + 真实 Worker 集成
npm run test:e2e        # 浏览器 UI
npm run licenses        # 生产依赖许可证清单
npm run check:secrets   # 仓库秘密扫描
```

实测记录见 [TEST-RESULTS](docs/development/TEST-RESULTS.md)。Docker 运行验证由 CI 的 Docker job 执行；不得把未运行的容器检查标为通过。

## 文档

- [PRD](docs/PRD.md) · [架构](docs/ARCHITECTURE.md) · [插件规范](docs/architecture/PLUGIN-SPEC.md)
- [REA 对照研究](docs/research/rea-comparison.md) · [路线图](docs/ROADMAP.md)
- [开发进度](docs/development/PROGRESS.md) · [已知问题](docs/development/KNOWN-ISSUES.md)
- [CLI/MCP 指南](docs/user-guide/CLI-MCP.md)

## 许可证

Apache-2.0。第三方组件遵循各自许可证；详见 [NOTICE](NOTICE)。不得使用本项目分发未经授权的商业软件或游戏资源。
