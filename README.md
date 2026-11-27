# 逆向万物 · Reverse Everything

**Autopilot 自然语言驱动的本地逆向与兼容重建工作台 · v0.0.8**

当前稳定版：**v0.0.8**，已于 2026-11-27 正式发布。

[![CI](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/alicia1030su/reverse-everything/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v0.0.8-blue.svg)](https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.8)
[English](README.en.md)

![逆向万物横幅](docs/assets/banner.svg)

## v0.0.8：把目标交给 Autopilot

用自然语言说出你想完成的事，例如“分析这个旧软件并生成兼容重建方案”或“重建这个网站并交付可部署产物”。Autopilot 会先补齐必要信息，展示**目标契约**与**执行计划**，在你明确确认后执行真实分析、构建、测试和独立规则验收，最后交付带 SHA-256、教程和验收报告的工件。

**默认规则型、默认 local-only，不需要 API Key。** Provider V4 模型管理已经提供多角色配置、能力探测、预算和故障切换，但真实远程模型尚未接入完整 Autopilot 主链；正式候选的真实 Key 端到端验收如实记录为 `BLOCKED / MISSING_API_KEY`，不得把 Mock 或规则型结果称为真实模型能力。v0.0.8 已正式发布，当前稳定版为 v0.0.8。

真实流程：描述目标 → 回答动态问题 → 确认授权/预算/验收契约 → 确认依赖计划 → 执行真实步骤 → 在交付中心复核工件与限制。详见 [Autopilot 指南](docs/AUTOPILOT.md) 与 [新手快速开始](docs/BEGINNER-QUICKSTART.md)。

### 界面截图占位（尚未生成）

Autopilot 的真实 Web/Electron E2E 已通过；以下仅为尚未生成的文档截图占位，不得冒充实际截图：

```text
[待生成截图] Autopilot 自然语言首页：/autopilot
[待生成截图] 目标契约与执行计划确认：/autopilot/:id
[待生成截图] 交付中心与独立验收：/delivery/:id
[待生成截图] Provider V4 模型管理：/models
```

生成后须记录固定 Commit、浏览器/视口、任务 ID 与真实验收状态，并替换本占位。

## v0.0.7：Legacy Studio 与 V5 Game Revival

逆向万物把**已授权目标**转化为可追溯的分析任务：真实工具输出、持久化阶段、可恢复状态、可重复验证和可下载产物。v0.0.7 新增 Legacy Software Revival Studio、只读老软件识别、兼容/合法许可诊断、数据恢复与独立工具生成，并将游戏复活升级为 V5 行为 IR 驱动的反模板实现。

## 界面预览

| 游戏原客户端兼容 | 古老软件复活 | 智能分析向导 |
|---|---|---|
| ![Pixelknight 原客户端](docs/assets/v007-pixelknight-compat.png) | ![Legacy Studio](docs/assets/v007-legacy-studio.png) | ![智能分析向导](docs/assets/v005-wizard.png) |

> 仅分析你拥有或明确获授权的目标。不得绕过登录、验证码、付费、DRM、反作弊或访问控制。本项目不提供主机越狱、权限提升、安全启动绕过、自动漏洞利用或未授权设备访问。完整声明见 [DISCLAIMER.md](DISCLAIMER.md)。

## v0.0.7：Legacy Studio 与 V5 Game Revival

- **Legacy Software Revival Studio**：只读识别 PE/ELF/Mach-O、MSI/JAR/Electron/Python 线索与安装目录，生成兼容性和合法许可诊断；不执行原程序。
- **数据恢复**：支持 CSV、DBF、SQLite、INI、JSON、XML 的有界只读解析，导出独立 JSON/CSV 与 SHA-256 manifest。
- **独立软件重建**：生成 INI 编辑器、CSV 查看器与文本工具，运行真实测试和启动检查；不复用未授权源码或资源。
- **Local Privacy**：Legacy 分析默认全本地、不调用远程 AI、不下载外部依赖；目录白名单与共享确认保持显式。
- **V5 行为 IR**：游戏生成器消费 `revival-behavior/v1` 的动作、规则、胜负与地图；保留反模板样本验证不同行为。
- **兼容证据分离**：L0-L7 表示生成服务实现等级；目标行为、原客户端和协议兼容单独报告，后两者默认 `UNKNOWN`。
- **全入口**：`tasks create` 与 MCP `create_task` 新增 `legacy` adapter，MCP 总数仍为 44；游戏 CLI 与 REST 路由继续可用。
- **真实原客户端案例**：Pixelknight 与 Tron 的原始浏览器客户端已连接独立服务端，完成双人连接、移动、持久化/重连与对局结束；许可证与固定提交记录在 `examples/game-compat/UPSTREAM.md`。
- **CI 事实**：v0.0.6 的 FPS/RPG Docker/L7 已在正式候选 CI 真实通过；这不代表商业游戏原客户端兼容。

## 六种使用方式

| 方式 | 适合谁 | 入口 |
|---|---|---|
| Web 控制台 | 浏览器用户 | `npm start` 后打开 `http://127.0.0.1:4173` |
| Windows 桌面端 | 普通用户 | 安装 EXE 或解压 Portable |
| CLI | 脚本与自动化 | `reverse-everything` |
| REST API | 集成与自定义客户端 | `/api/v1` 或 `/api` |
| MCP | AI 客户端 | stdio 与 Streamable HTTP |
| Skill | 普通 AI 助手 | `skills/reverse-everything` |

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

宿主端口只绑定 `127.0.0.1`；默认不映射 USB，也不使用 privileged。Windows 可使用安装包、Portable 或上述 Node.js 流程；Linux 使用 Node.js 22.13+ 或 Docker Compose。游戏目录扫描需在 API 服务端显式配置 `RE_GAME_ROOTS`，Legacy 本机路径分析需配置 `RE_LEGACY_ROOTS`（Windows 用 `;` 分隔，Linux/Docker 用 `:` 分隔），只允许绝对路径及其子目录。Docker 只读挂载与配置示例见 [docker-compose.yml](docker-compose.yml) 和 [.env.example](.env.example)。v0.0.6 的生成服务 Docker/L7 已在正式候选 CI 通过；本机未运行 Docker 时仍只记录本机实测范围。

## Legacy Software Revival Studio

在“创建项目”中选择“软件复活/老软件”，进入 Legacy Studio：

1. 保存合法样本、来源、授权范围和待恢复功能。
2. 上传文件，或配置 API 服务端 `RE_LEGACY_ROOTS` 后读取允许目录。
3. 只读识别格式、架构、运行时、依赖和数据文件；不执行原程序。
4. 查看兼容性建议与许可证记录状态；`UNKNOWN` 不因可运行而自动改变。
5. 按需恢复 CSV/DBF/SQLite/INI/JSON/XML，或生成独立 INI/CSV/文本工具。
6. 查看真实测试、启动检查、SHA-256 与限制，下载独立产物。

详见 [老软件指南](docs/LEGACY-SOFTWARE.md)、[数据恢复](docs/DATA-RECOVERY.md)、[独立重建](docs/SOFTWARE-RECONSTRUCTION.md)、[本地隐私](docs/LOCAL-PRIVACY.md) 与 [许可诊断](docs/LICENSE-DIAGNOSTICS.md)。

## Game Revival Studio

在“创建项目”中选择“游戏复活”，进入游戏复活工作台：

1. 保存游戏名称、FPS/RPG 类型、来源、授权范围与尚未恢复功能。
2. 配置 API 服务端 `RE_GAME_ROOTS`，填入允许目录内的本机绝对路径；未配置或越界均返回 403。
3. 只读增量扫描目录并计算文件指纹，不上传原始游戏文件。
4. 扫描唯一的 `behavior.json`/`gameplay.json`，生成 V5 行为 IR 规格，再创建独立服务端重建任务。
5. 查看真实构建、内部协议客户端同场、房间隔离、持久化、重连、结算与并发报告；下载通过验证的 ZIP。

L0 档案 → L1 扫描指纹 → L2 规格 → L3 生成并构建 → L4 独立启动与管理认证 → L5 内部客户端同场/权威状态/房间隔离 → L6 持久化/重连/结算/多房间并发 → L7 Docker 部署。L0-L7 是生成服务实现等级；目标行为、原客户端与协议兼容单独报告，原客户端和协议默认 `UNKNOWN`。反模板样本用于证明行为差异，内部客户端或 Docker 通过不等于商业原客户端兼容。详见 [游戏兼容指南](docs/GAME-COMPATIBILITY.md)。

## 开始智能分析

1. 点击“开始智能分析”。
2. 选择 PS5、Xbox、Android TV、USB、固件、软件、Android、网页、游戏、协议或安全入口。
3. 提供文件、设备摘要或授权 URL，并确认合法分析范围。
4. 系统自动检测环境、选择可用分析器并生成有界计划。
5. 查看真实步骤、日志、证据和资源消耗。
6. 切换普通用户/专业报告视图并导出结果。

未配置 AI 时，确定性计划和规则型分析仍可运行。AI 文本始终标为 `INFERENCE`，不能替代工具证据。

## 游戏主机研究实验室

主机研究模块的目标对象是**游戏主机本体**，不是游戏控制器。

- 设备目录：PS5、PS5 Slim、PS5 Pro、PS4、Xbox Series X/S、Xbox One、Android TV、Android 电视盒子、其他开放式嵌入式设备。
- 档案：制造商、系列、型号、硬件版本、系统版本、官方接口、授权开发环境、固件样本、证据和限制。
- USB 诊断：只读判断系统识别、描述符、普通接口、拓扑、官方开发环境需求和硬件安全风险。
- 等级：C0 档案、C1 身份与官方资料记录、C2 合法接口、C3 静态分析、C4 授权开发环境实测、C5 自有设备独立兼容实现。C1 仅表示资料已记录；C2 及以上只计入后端验证证据，用户自述不能提升等级。

设备出现在目录中不代表已经支持其内部系统分析。USB Type-C 外形不能作为调试依据；不支持普通零售主机对主机连接。

详见 [主机研究指南](docs/user-guide/CONSOLE-RESEARCH.md)、[PS5](docs/user-guide/PS5.md)、[Xbox](docs/user-guide/XBOX.md)、[Android TV](docs/user-guide/ANDROID-TV.md)。

## 能力入口

| 入口 | 输入与输出 | 实际路由与边界 |
|---|---|---|
| `website` 网页 | DOM、脚本、路由、表单、截图、同源网络元数据 | `website` adapter；不绕过访问控制 |
| `software` 软件 | PE/ELF/Mach-O、section/import、熵、有界字符串、ZIP、SBOM | `file` adapter；不执行未知程序 |
| `legacy` 老软件 | 只读软件档案、兼容/许可诊断、数据恢复、独立工具生成 | `legacy` adapter；不执行原程序，不绕过许可 |
| `android` Android | APK/ZIP 安全清单、AXML Manifest、DEX 表与原生库元数据 | `apk` adapter；JADX 反编译需官方工具 |
| `game` 游戏复活 | 合法回放的协议字段、状态转换、独立兼容服务 | `game` adapter；不是原始服务端恢复 |
| `network` 网络协议 | HAR、PCAP、PCAPNG 的端点、HTTP/DNS/TLS 与传输元数据 | `network` adapter；只解析离线上传 |
| `security` 安全 | 被动 HTTP 头/Cookie/CORS、静态 CWE 候选、SARIF | `security` adapter；不进行漏洞利用 |
| `usb` USB 硬件 | USB 身份/拓扑、离线 PCAP/PCAPNG/usbmon、HID 描述符、快照 | `hardware` adapter；只读枚举，不打开设备 |
| `firmware` 固件 | BIN/IMG、Intel HEX、UF2、ELF、布局、熵、字符串、组件/SBOM 线索 | `firmware` adapter；静态有界分析，不刷写 |
| `board` 开发板 | 开发板 USB/HID/枚举记录与只读串口列表 | `hardware` adapter；不虚构特定型号或实时权限 |
| `console` 主机研究 | 设备档案、USB 诊断、C0-C5 证据、离线样本与报告 | `console` adapter；不执行设备操作或绕过 |

Ghidra Headless 是 `software` 卡片内的高级选项，使用独立 `ghidra` adapter。Ghidra 12.2 与 JADX 1.5.3 已通过官方工具已知答案 CI；不覆盖所有格式、架构或物理设备。

## CLI 示例

```bash
reverse-everything --version
reverse-everything health
reverse-everything capabilities
reverse-everything console devices
reverse-everything projects create "我的授权样本" software --authorized
reverse-everything projects upload <projectId> ./sample.bin
reverse-everything tasks create <projectId> legacy
reverse-everything analyze file ./sample.bin --authorized
reverse-everything plans create <projectId> "总结离线请求" ./capture.har --authorized
reverse-everything plans execute <planId>
reverse-everything demos list
reverse-everything demos run firmware
reverse-everything report plain <taskId> ./report.md
reverse-everything game profile <projectId> "自有 FPS" fps /absolute/games/owned-fps --authorized
reverse-everything game scan <projectId> /absolute/games/owned-fps --authorized
reverse-everything game spec <projectId>
reverse-everything game rebuild <specId>
reverse-everything game status <rebuildId>
reverse-everything game download <rebuildId> ./server.zip
reverse-everything mcp stdio
reverse-everything mcp http --port 4174
```

本地 URL 需 `--confirm-local`。默认读取 `RE_DATA_DIR/local-token`，可用 `RE_API_URL`、`RE_API_TOKEN`、`RE_DATA_DIR` 覆盖。完整命令见 [CLI 指南](docs/user-guide/CLI.md)。

## REST API、OpenAPI 与 MCP

- API：`http://127.0.0.1:4173/api/v1`；兼容 `/api`。
- OpenAPI：运行时 `GET /api/openapi.json`。
- MCP：stdio 与 Streamable HTTP 共用 API。v0.0.7 基线共 **44 个工具**；v0.0.8 新增 10 个 `autopilot_*` 工具，总计 54 个。`create_task` 的 adapter 包含 `legacy`，游戏工具仍为 `list_game_profiles`、`save_game_profile`、`scan_game_directory`、`create_game_server_spec`、`list_game_rebuilds`、`create_game_rebuild`、`get_game_rebuild`。
- Skill：`skills/reverse-everything`，优先使用 MCP，否则使用 CLI/API。

所有入口共用后端授权、Schema、预算和结构化错误。清理、设备打开、实时捕获、刷写、驱动安装和任意宿主任意命令执行不暴露给 MCP。

## 安全与隐私

- 默认只读、本地保存、凭证脱敏、隔离未知程序。
- 默认禁止任意硬件写入、驱动安装、管理员操作和宿主任意命令执行。
- 默认不上传用户样本到远程 AI；远程共享必须显式同意。Legacy 分析默认全本地，不调用远程 AI 或下载外部依赖。
- Legacy 本机路径仅读取 `RE_LEGACY_ROOTS` 允许目录；数据恢复写入独立目录并校验来源哈希。
- 设备可控自由文本默认仅返回单向哈希。
- 未授权物理设备不访问；实时 USB 捕获、驱动安装和刷写保持禁用。
- 固件只做有界静态识别；加密或高熵内容保持 `UNKNOWN`。

详见 [安全策略](SECURITY.md) 与 [免责声明](DISCLAIMER.md)。

## 下载

当前稳定版 v0.0.8 已于 2026-11-27 正式发布。以下资产固定指向 [v0.0.8 Release](https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.8)，不会随 Latest 变化；正式发行 Run 为 `45994026211`。

| 平台 / 形态 | 文件 |
|---|---|
| Windows 安装包 | [Reverse-Everything-Setup-0.0.8-win-x64.exe](https://github.com/alicia1030su/reverse-everything/releases/download/v0.0.8/Reverse-Everything-Setup-0.0.8-win-x64.exe) |
| Windows Portable | [Reverse-Everything-Portable-0.0.8-win-x64.zip](https://github.com/alicia1030su/reverse-everything/releases/download/v0.0.8/Reverse-Everything-Portable-0.0.8-win-x64.zip) |
| CLI | [reverse-everything-cli-0.0.8.tgz](https://github.com/alicia1030su/reverse-everything/releases/download/v0.0.8/reverse-everything-cli-0.0.8.tgz) |
| Server | [reverse-everything-server-0.0.8.tar.gz](https://github.com/alicia1030su/reverse-everything/releases/download/v0.0.8/reverse-everything-server-0.0.8.tar.gz) |
| Skill | [reverse-everything-skill-0.0.8.zip](https://github.com/alicia1030su/reverse-everything/releases/download/v0.0.8/reverse-everything-skill-0.0.8.zip) |

下载 `SHA256SUMS.txt` 后运行 `sha256sum -c SHA256SUMS.txt` 验证资产。Windows 安装包未签名，可能触发 SmartScreen；不伪造代码签名。

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

v0.0.8 冻结 Commit 的分平台结果见 [V008 测试结果](docs/development/V008-TEST-RESULTS.md)：Ubuntu 906 passed / 7 skipped，Windows 905 passed / 8 skipped；完整 E2E 32/32。正式候选 Run `45986134905` 与原子发行 Run `45994026211` 均通过，15 个公开资产已复核 SHA-256。未运行的检查不标为通过。

- [PRD](docs/PRD.md) · [架构](docs/ARCHITECTURE.md) · [安全模型](docs/SECURITY-MODEL.md) · [路线图](docs/ROADMAP.md)
- [老软件](docs/LEGACY-SOFTWARE.md) · [独立重建](docs/SOFTWARE-RECONSTRUCTION.md) · [数据恢复](docs/DATA-RECOVERY.md) · [本地隐私](docs/LOCAL-PRIVACY.md) · [许可诊断](docs/LICENSE-DIAGNOSTICS.md) · [游戏兼容](docs/GAME-COMPATIBILITY.md)
- [小白指南](docs/user-guide/BEGINNER.md) · [主机研究](docs/user-guide/CONSOLE-RESEARCH.md)
- [CLI](docs/user-guide/CLI.md) · [CLI/MCP](docs/user-guide/CLI-MCP.md) · [API](docs/user-guide/API.md) · [Skill](docs/user-guide/SKILL.md)
- [Windows](docs/user-guide/WINDOWS.md) · [升级](docs/user-guide/UPGRADE.md) · [能力矩阵](docs/development/V006-CAPABILITY-MATRIX.md)

## 许可证

Apache-2.0。第三方组件遵循各自许可证；详见 [NOTICE](NOTICE) 与 [免责声明](DISCLAIMER.md)。不得使用本项目分发未经授权的商业软件、固件或游戏资源。
