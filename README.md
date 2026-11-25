# 逆向万物 · Reverse Everything

**AI 辅助的本地逆向工程与数字软件兼容重建工作台 · v0.0.4 开发分支**

[![CI](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[English](README.en.md)

![逆向万物横幅](docs/assets/banner.svg)

逆向万物把**已授权目标**转化为可追溯的分析任务：真实工具输出、持久化阶段、可恢复状态、可重复验证和可下载产物。它不是反编译器数量排行榜，也不承诺无条件恢复所有软件。

> 仅分析你拥有或明确获授权的目标。不得绕过登录、验证码、付费、DRM、反作弊或访问控制。v0.0.4 仍在 `feat/v0.0.4-hardware-lab` 开发；本页不表示 Tag 或正式 Release 已发布。

## v0.0.4 能力入口

Web、REST、CLI、MCP 与 Skill 共用同一任务引擎。九个分析入口如下；入口名称不等同于新的 adapter。

| 入口 | 输入与输出 | 实际路由与边界 |
|---|---|---|
| `website` 网页 | DOM、脚本、路由、表单、截图、同源网络元数据 | `website` adapter；不绕过访问控制，本地演示需单独确认 |
| `software` 软件 | PE/ELF/Mach-O、section/import、熵、有界字符串、ZIP、SBOM | `file` adapter；不执行未知程序 |
| `android` Android | APK/ZIP 安全清单、AXML Manifest、DEX 表与原生库元数据 | `apk` adapter；JADX 反编译代码已实现，真实 CI 证据完成前为 `PARTIAL` |
| `game` 游戏复活 | 合法回放的协议字段、状态转换、独立兼容服务 | `game` adapter；不是原始服务端恢复 |
| `network` 网络协议 | HAR、PCAP、PCAPNG 的端点、HTTP/DNS/TLS 与传输元数据 | `network` adapter；只解析离线上传，不访问抓包中的目标 |
| `security` 安全 | 被动 HTTP 头/Cookie/CORS、静态 CWE 候选、SARIF | `security` adapter；不进行漏洞利用或未授权主动扫描 |
| `usb` USB 硬件 | USB 身份/拓扑、离线 PCAP/PCAPNG/usbmon、HID 描述符、快照 | 项目 kind 与 adapter 均为 `hardware`；只读枚举，不打开设备、不实时抓包、不采集键盘报告 |
| `firmware` 固件 | BIN/IMG、Intel HEX、UF2、ELF、布局、熵、字符串、组件/SBOM 线索 | `firmware` adapter；静态有界分析，不执行、不解包运行、不刷写 |
| `board` 开发板 | 开发板 USB/HID/枚举记录与只读串口列表 | **硬件场景路由**：项目 kind 与 adapter 均为 `hardware`；不调用 `firmware`，不宣称特定品牌/型号或实时设备支持 |

Ghidra Headless 是 `software` 卡片内的高级选项，使用独立 `ghidra` adapter。函数、伪代码、调用图与字符串引用代码已实现，但在真实 Ghidra/JDK 已知答案 CI 证据完成前保持 `PARTIAL` / `BLOCKED`，不标为 `VERIFIED`。完整状态见 [能力矩阵](docs/development/V004-CAPABILITY-MATRIX.md)。

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

Docker：

```bash
docker compose up -d --build
curl http://127.0.0.1:4173/api/health
docker compose down          # 保留数据
docker compose down -v       # 删除数据卷
```

宿主端口只绑定 `127.0.0.1`；默认不映射 USB，也不使用 privileged。

## 创建第一个任务

1. 打开“新建分析”，选择九类入口之一。
2. 输入授权 URL 或选择本地文件；开发板从硬件实验室查看只读串口/设备列表。
3. 确认合法授权；本地演示 URL 需额外勾选本地权限。
4. 在任务工作台查看真实阶段、日志、证据和产物，可暂停、恢复、取消或重试。
5. 下载 `report.md`、`findings.sarif`、`manifest.json` 或兼容服务等产物，并核对 SHA-256。

未配置 AI 时，规则型分析仍可运行。AI 文本始终标为 `INFERENCE`，不能替代工具证据。

## CLI

构建后可使用仓库内入口；安装 CLI 包后命令名为 `reverse-everything`。

```bash
node apps/cli/dist/cli.js --version
node apps/cli/dist/cli.js health
node apps/cli/dist/cli.js capabilities
node apps/cli/dist/cli.js analyzers list
node apps/cli/dist/cli.js projects list
node apps/cli/dist/cli.js projects create "我的授权样本" software --authorized
node apps/cli/dist/cli.js projects upload <projectId> ./sample.bin
node apps/cli/dist/cli.js analyze file ./sample.bin --authorized
node apps/cli/dist/cli.js analyze web https://example.com --authorized
node apps/cli/dist/cli.js tasks create <projectId> firmware
node apps/cli/dist/cli.js tasks list
node apps/cli/dist/cli.js tasks get <taskId>
node apps/cli/dist/cli.js tasks action <taskId> pause
node apps/cli/dist/cli.js report export <taskId> ./report.md
node apps/cli/dist/cli.js hardware list
node apps/cli/dist/cli.js hardware doctor
node apps/cli/dist/cli.js hardware serial
node apps/cli/dist/cli.js firmware inspect ./firmware.bin --authorized
node apps/cli/dist/cli.js resources status
node apps/cli/dist/cli.js cache stats
node apps/cli/dist/cli.js retention show
node apps/cli/dist/cli.js mcp stdio
node apps/cli/dist/cli.js mcp http --port 4174
```

本地 URL 需 `--confirm-local`。默认读取 `RE_DATA_DIR/local-token`，可用 `RE_API_URL`、`RE_API_TOKEN`、`RE_DATA_DIR` 覆盖。完整命令、项目 kind 与 adapter 对照见 [CLI 指南](docs/user-guide/CLI.md)。

## REST API、OpenAPI 与 MCP

- API：`http://127.0.0.1:4173/api/v1`；兼容 `/api`，两者路由相同。
- OpenAPI：运行时 `GET /api/openapi.json`，版本为 **0.0.4**；源生成器为 `scripts/generate-openapi.mjs`。
- MCP：stdio 与 Streamable HTTP 共用 API，提供 **21 个工具**。
- Skill：`skills/reverse-everything`，优先使用 MCP，否则使用 CLI/API。

MCP 工具包括项目/任务/报告、能力/健康/资源、硬件能力/设备/串口/硬件报告、证据/事件/产物清单、缓存列表/统计。清理、设备打开、实时捕获与刷写不暴露给 MCP。配置与完整工具表见 [CLI/MCP 指南](docs/user-guide/CLI-MCP.md) 和 [API 指南](docs/user-guide/API.md)。

## 硬件与固件安全边界

- USB 与串口只做系统只读枚举；序列号不读取，设备可控的 friendly name、manufacturer、driver、interface/configuration 自由文本默认不返回原文，仅保留单向哈希；串口不打开且不改变 DTR/RTS。
- 硬件分析只接受离线上传的 USB PCAP/PCAPNG、usbmon、HID 描述符或枚举快照；原始数据包 payload 不写入证据。
- 未授权物理设备不访问；实时 USB 捕获、驱动安装、键盘报告捕获保持禁用。断开/重连后必须重新核验身份与授权。
- 固件只做有界静态识别；加密或高熵内容保持 `UNKNOWN`，不自动绕过保护。
- 开发板不是新的执行权限：查看串口列表不等于获得登录、复位、控制线或刷写授权。

详见 [安全模型](docs/SECURITY-MODEL.md)。

## 证据与验收状态

- `EVIDENCE`：实际工具输出。
- `INFERENCE`：规则或模型推断，必须可追溯。
- `UNKNOWN`：证据缺失，不伪装成结论。
- `VERIFIED`：通过可重复测试的结论。

实现状态使用 `IMPLEMENTED`、`PARTIAL`、`BLOCKED`、`MISSING` 等标签，不能与证据等级混用。所有主要证据包含 source、locator 与 SHA-256；导出 manifest 记录输入哈希、工具版本、阶段和产物哈希。

## 缓存、保留与删除

- 缓存仅覆盖可复用的纯阶段；默认项目隔离，跨项目共享需显式批准。缓存键包含输入、adapter/阶段/工具版本与脱敏选项；读取校验 SHA-256，损坏条目按 miss 处理。
- `retention show` 只显示策略；维护先 preview，再以 `confirm=CLEAN` 应用。运行中任务的临时文件与日志受保护。
- 保留策略不自动删除原始上传或正式任务产物。清缓存需 `confirm=CLEAR_CACHE`；删除项目需精确项目名，存在活动任务时拒绝。

## 桌面、Windows 与单实例

- 桌面指标合并 Electron `app.getAppMetrics()` 与真实 API/Worker sidecar 快照；采样失败、陈旧或截断会写入 `limitations`，不伪造完整进程树。
- Windows 工件下载使用私有临时快照，通过 `icacls` 限制为当前用户并拒绝 reparse point 路径；POSIX 使用 0600。
- API 使用 SQLite runtime lease 防止同一数据目录多实例；Electron 使用单实例锁，第二次启动聚焦已有窗口。

## 测试与文档

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run docs:check
npm run validate:skill
npm run version:check
```

测试数量、跳过项、CI Run ID 与门禁结论以 [v0.0.4 测试结果](docs/development/V004-TEST-RESULTS.md) 和最终门禁为准；未运行的检查不标为通过。当前限制见 [v0.0.4 已知问题](docs/development/V004-KNOWN-ISSUES.md)。

- [PRD](docs/PRD.md) · [架构](docs/ARCHITECTURE.md) · [安全模型](docs/SECURITY-MODEL.md) · [路线图](docs/ROADMAP.md)
- [CLI](docs/user-guide/CLI.md) · [CLI/MCP](docs/user-guide/CLI-MCP.md) · [API](docs/user-guide/API.md) · [Skill](docs/user-guide/SKILL.md)
- [Windows](docs/user-guide/WINDOWS.md) · [升级](docs/user-guide/UPGRADE.md) · [能力矩阵](docs/development/V004-CAPABILITY-MATRIX.md)

## 许可证

Apache-2.0。第三方组件遵循各自许可证；详见 [NOTICE](NOTICE)。不得使用本项目分发未经授权的商业软件、固件或游戏资源。
