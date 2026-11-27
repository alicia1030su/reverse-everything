# 逆向万物路线图

所有版本状态以代码、测试、CI 与发布记录为准。

## v0.0.1：可验证基础平台（已发布）

- Monorepo、Web/API/Worker/CLI/MCP。
- 项目、上传、哈希、SQLite 任务、检查点、SSE。
- 网页采集、文件静态分析、基础安全、可选 AI。
- 自编写游戏协议推断、独立兼容服务与 E2E。
- Docker Compose、CI、文档与真实示例。

## v0.0.2：分析效率（已发布）

- Schema 迁移、备份/隔离恢复。
- 跨任务缓存、保留策略、资源指标与内存压力。
- CLI TGZ、Server TGZ、Skill、Windows 安装/便携版。

## v0.0.3：网页与深度逆向（已发布）

- 多页面网页采集、HAR/PCAP/PCAPNG 离线解析。
- APK/ZIP/AXML/DEX 静态元数据。
- Ghidra Headless 基础进程链。
- 可证明发行流程与全入口契约。

## v0.0.4：硬件实验室与原生分析（已发布）

- 九类入口：website/software/android/game/network/security/usb/firmware/board。
- Windows/Linux USB 与串口只读枚举、设备身份/拓扑与脱敏。
- 离线 USB PCAP/PCAPNG/usbmon、HID 描述符与快照解析。
- 固件 BIN/IMG、Intel HEX、UF2、ELF、ZIP 清单、熵、字符串、布局、组件/SBOM 线索。
- Ghidra 12.2 伪代码/调用图/字符串引用与 JADX 1.5.3 反编译进程链，官方已知答案 CI 通过。
- CLI 硬件/固件命令、MCP 21 工具、OpenAPI v0.0.4、Skill 工作流。
- 桌面真实进程指标、Windows 私有快照 ACL、API/Electron 单实例。
- Release ID 驱动的 Draft 上传与公开资产复验。

## v0.0.5：主机研究实验室与智能逆向向导（已发布）

- Console Research Lab：PS5/PS4/Xbox/Android TV/开放嵌入式设备档案、USB 诊断、C0-C5 证据等级。
- 智能逆向向导：小白、专业、AI Agent 三模式。
- 自动分析计划：目标识别、环境检测、授权、能力匹配、执行、证据、验证、报告。
- AI V3 多角色受限工作流与完整预算。
- 内置演示中心、普通用户/专业双视图报告、Markdown/JSON/HTML 导出。
- Schema 4、授权范围中心、工具管理器与全入口契约。
- 发行脚本分页、Release ID、限流重试、公开后复验。

## v0.0.6：Game Revival（已发布）

- Game Revival Studio：合法游戏档案、只读增量目录扫描、文件指纹与证据分级服务端规格。
- L0-L7：档案 → 扫描 → 规格 → 生成构建 → 独立启动/管理认证 → 双客户端同场/权威状态/房间隔离 → 持久化/重连/结算/多房间并发 → Docker 部署。
- 自有多人 FPS/RPG 独立 TypeScript/Node/WebSocket 服务端、认证管理后台、可下载 ZIP；不依赖平台 API。
- CLI `game profile|scan|spec|rebuild|status|download`、REST 游戏复活路由、MCP 44 工具（新增 7 个）与 Skill 工作流。
- `scan_game_directory` 仅扫描 API 服务端 `RE_GAME_ROOTS` 显式允许的目录；未配置返回 403，HTTP MCP 不能绕过。
- 本机未运行 Docker；v0.0.6 正式候选 CI 的 FPS/RPG Docker/L7 已真实通过，仅证明生成服务部署能力。
- 独立兼容实现不是原始服务端，不保证商业原客户端兼容，不绕过 DRM/反作弊/认证，不分发未授权资源。

## v0.0.7：Legacy Studio 与 V5 Game Revival（已发布）

2026-11-26 正式发布；annotated Tag `v0.0.7` 解引用 Commit `a54871a57e68aa0833a1636b79cf98e15bcd7cbe`，正式发行 Run `45912292229`。分平台冻结测试结果见 [V007 测试结果](development/V007-TEST-RESULTS.md)。

- Legacy Software Revival Studio：PE/ELF/Mach-O、MSI/JAR/Electron/Python 与安装目录只读识别，兼容性和合法许可诊断。
- CSV/DBF/SQLite/INI/JSON/XML 有界只读恢复，独立 JSON/CSV 导出与来源/产物 SHA-256。
- 独立 INI 编辑器、CSV 查看器与文本工具生成，真实测试和启动验证。
- Local Privacy：Legacy 默认全本地、无远程 AI、无外部依赖下载；显式目录白名单与共享确认。
- 游戏 V5 `revival-behavior/v1` 行为 IR、反模板样本、目标行为/原客户端/协议证据分离；原客户端与协议默认 `UNKNOWN`。
- `tasks create` 与 MCP `create_task` 支持 `legacy`，MCP 仍为 44 工具。
- 不以内部客户端、文件生成或 Docker/L7 冒充真实商业游戏原客户端兼容；未完成的真实兼容保持 `BLOCKED`。

## v0.0.8：Autopilot 自然语言工作台（已发布）

2026-11-27 正式发布；annotated Tag object `79da5c63649ede8001457ae80dbe6c9b0a7335fc` 解引用 Commit `d2334ee267098e30f44b72c80f975e520abbc47c`，正式发行 Run `45994026211`，15 个公开资产复验通过。

- 自然语言目标、动态需求发现、目标契约、依赖计划与持久化 Autopilot 编排。
- Web/Desktop 默认首页升级为 Autopilot，并新增交付中心与 Provider V4 模型管理。
- REST/CLI/MCP stdio/HTTP/Skill 全入口共享核心；MCP 总计 54 个工具。
- Schema 7、暂停/恢复/取消、租约续期、受限重规划、工具注册与独立规则验收。
- 交付包包含教程、验收报告、manifest 与 SHA-256；真实远程模型保持 `BLOCKED / MISSING_API_KEY`。

## v0.0.9：安全研究与多 Agent 协同

- 更多专业角色共享结构化状态、多模型路由与预算。

## v0.1.0：完整工作流

- 网页、软件、游戏、硬件、固件和主机的跨层证据与行为对比。
- 可复现构建、失败项目标注与更成熟的数字保存治理。

## v0.2.0 → v1.0.0

- 分布式 Worker、插件生态、更多平台、成熟发布与合规治理。

## 明确不做

- 无授权扫描、绕过访问控制、自动窃取数据、漏洞批量利用。
- 商业主机越狱、权限提升、安全启动/DRM 绕过、自动漏洞利用。
- 打开未授权设备、实时键盘捕获、未授权固件刷写。
- 自动分发无授权商业资源。
- 把模型猜测当作事实。
- 用占位按钮、随机进度、预写兼容服务冒充自动恢复。
