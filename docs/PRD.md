# 逆向万物 v0.0.6 产品需求文档

## 1. 定位与目标

逆向万物是本地单用户的 AI 辅助逆向工程与数字软件兼容重建工作台。核心闭环：

**授权项目 → 上传/输入目标 → 持久化分析 → 证据与发现 → 验证 → 报告/产物导出**。

核心原则：证据驱动、自动化优先、可验证、可恢复、可扩展、安全隔离。不能可靠实现的能力必须标为 `UNKNOWN`、`PARTIAL` 或 `BLOCKED`，不得伪装成完成。

v0.0.6 聚焦 Game Revival Studio、L0-L7 证据等级、自有多人 FPS/RPG 独立服务端、管理后台与 Docker/Windows/Linux 部署；本版本状态以最终测试、CI 与发布记录为准。

## 2. 用户与场景

- 开发者：理解自己维护或获授权的网页、软件、Android 应用与固件。
- 安全研究员：对授权目标做被动检查、静态复核与离线记录分析。
- 数字保存/兼容开发者：用合法保留的客户端与回放生成独立本地兼容服务。
- 硬件研究者：只读枚举本机设备、分析授权 USB/HID 记录与开发板固件。
- Agent/自动化用户：通过 CLI、MCP、REST 或 Skill 调用同一任务契约。

非目标：匿名多租户、公开托管、无授权扫描、绕过登录/验证码/付费/DRM/反作弊、自动漏洞利用、打开未授权物理设备、实时键盘捕获、固件刷写、商业资源分发、保证恢复所有软件。

## 3. 九类分析入口

| 入口 | 用户输入 | 项目 kind | adapter | 主要产物 |
|---|---|---|---|---|
| website | 授权 URL | `website` | `website` | 网页快照、交互/路由、截图、同源网络元数据 |
| software | 本地二进制/归档 | `software` | `file` | 格式、section/import、熵、字符串、ZIP、SBOM |
| android | APK/ZIP/DEX | `software` | `apk` | Manifest、DEX 表、组件与原生库元数据；JADX 产物按可用性 |
| game | 合法 replay-trace | `game` | `game` | 协议字段、状态转换、独立兼容服务 |
| network | HAR/PCAP/PCAPNG | `protocol` | `network` | 端点、HTTP/DNS/TLS 与传输元数据 |
| security | URL 或源码/文本 | `security` | `security` | 被动检查、CWE 候选、SARIF |
| usb | USB 记录/HID/快照 | `hardware` | `hardware` | 设备/接口/端点/传输元数据与时间线 |
| firmware | BIN/IMG/HEX/UF2/ELF/ZIP | `firmware` | `firmware` | 身份、熵、字符串、布局、组件/SBOM 线索 |
| board | 开发板 USB/HID/枚举记录 | `hardware` | `hardware` | 只读串口/设备列表与离线记录分析；不调用 firmware，不宣称特定品牌/型号或实时设备支持 |
| console | 主机档案、USB 诊断、合法固件/应用样本 | `console` | `console` | C0-C5 证据档案、连接诊断、离线分析与双视图报告 |

`board` 是硬件场景路由，不新增 `board` adapter 或项目 kind。Ghidra 是 `software` 卡片内高级选项，使用独立 `ghidra` adapter；Ghidra 12.2/JDK25 与 JADX 1.5.3 已通过官方已知答案 CI，验证范围限于 CI 覆盖的 PE/ELF/APK 样本。

## 4. 核心流程

1. 用户选择入口并确认合法授权；本地 URL 需额外确认。
2. 系统保存输入并计算 SHA-256。
3. Worker 执行统一状态机：INTAKE → CLASSIFY → AUTHORIZATION_CHECK → PLAN → PREPARE → ANALYZE → COLLECT_EVIDENCE → MODEL_BEHAVIOR → RECONSTRUCT → VALIDATE → REPORT → EXPORT → COMPLETED。
4. 用户通过 SSE 观察真实阶段，并可暂停、恢复、取消、重试。
5. 证据分为 `EVIDENCE` / `INFERENCE` / `UNKNOWN` / `VERIFIED`。
6. 下载报告、证据清单、SARIF、manifest 与适用产物，并核对哈希。

## 5. 页面与验收

- 总览：统计全部来自 API；空状态不是假数据。
- 创建项目：九类入口、URL/文件/本地列表、授权与本地确认。
- 任务工作台：阶段、当前工具、日志、控制按钮、证据/发现/报告/产物。
- 证据探索器：搜索、过滤、关系、只读代码查看；原始内容不作为 HTML 渲染。
- 协议中心：消息类型、字段出现次数、转换与未知项。
- 复活实验室：L0-L7 等级、E2E 检查、独立重建声明。
- Game Revival Studio：游戏档案、允许目录只读扫描、服务端规格、重建状态、验证报告与 ZIP 下载。
- 安全中心：候选发现、证据、置信度与修复建议。
- 硬件实验室：真实只读 USB 拓扑、描述符、串口与离线任务入口。
- 主机研究实验室：设备目录、能力矩阵、USB 诊断、C0-C5 档案与报告。
- 智能向导：小白/专业/AI Agent 三模式、分类入口、自动检测与计划执行。
- 计划/工具/演示/授权中心：真实计划、预算、工具状态、内置演示与授权范围。
- 报告：普通用户/专业双视图，Markdown/JSON/HTML 导出。
- 验证中心：真实检查、限制、原始证据；无克隆时不伪造对比。
- 设置/运维：模型、工具可用性、资源、缓存、保留与备份。

## 6. 自动化入口

- CLI：`health`、`capabilities`、`analyzers`、`projects`、`analyze`、`tasks`、`report`、`hardware`、`firmware`、`console`、`game profile|scan|spec|rebuild|status|download`、`plans`、`tools`、`demos`、`resources`、`cache`、`retention`、`mcp`。
- REST：`/api/v1` 与 `/api` 同路由；OpenAPI v0.0.6。
- MCP：stdio 与 Streamable HTTP，共 44 个工具；新增游戏档案、目录扫描、规格、重建列表/创建/状态 7 个工具。
- Skill：授权检查、环境检测、任务查询与九类工作流；优先 MCP，否则 CLI/API。

所有入口共享项目/任务 ID、令牌、队列、预算与证据契约。

## 7. 证据与实现状态

实现状态与证据等级分离：

- `IMPLEMENTED`：存在真实实现，不等于已完成所有验收。
- `PARTIAL`：仅覆盖部分链路或缺少真实外部工具证据。
- `BLOCKED`：外部依赖、权限或设备授权阻塞。
- `MISSING`：未实现。
- `VERIFIED` 只能用于可重复测试证据，不能仅凭代码存在。

Ghidra/JADX 仅在官方 CI 已知答案范围内可标 `VERIFIED`，不扩展到未测试格式、架构或物理设备。游戏复活 L0-L7 只由真实报告推进：文件生成不算联机或部署成功；当前本地最高实测 L6，Docker 不可用，L7 待 CI。物理设备、实时 USB 捕获与刷写在未授权时保持 `BLOCKED` 或禁用。

## 8. 硬件、固件与安全需求

- USB/串口只读枚举；序列号脱敏；不打开设备、不改 DTR/RTS。
- 离线 USB PCAP/PCAPNG/usbmon、HID 描述符与快照有界解析；原始 payload 不写入证据。
- 键盘报告捕获默认禁用；重连后重新核验身份与授权。
- 固件流式/分块分析，限制大小、条目、字符串与输出；不执行、不解包运行、不刷写。
- 加密/高熵固件保持 `UNKNOWN`，不绕过保护。
- Windows 私有快照 ACL、reparse point 拒绝、API runtime lease 与 Electron 单实例锁属于交付要求。

## 9. 缓存、保留与删除

- 缓存仅用于可复用纯阶段；默认项目隔离，跨项目共享需显式批准。
- 缓存键包含输入哈希、adapter/阶段/工具版本与脱敏选项；读取验证 SHA-256。
- 维护先 preview 再 apply；活动任务的临时文件与日志受保护。
- 保留策略不自动删除原始上传或正式任务产物。
- 清缓存与项目删除必须显式确认；项目有活动任务时拒绝删除。

## 10. 质量门禁

- P0 阻塞缺陷为 0；失败测试不得删除或伪造通过。
- CLI 命令按当前 `--help` 核对；所有本地文档链接存在。
- Ghidra/JADX 真实工具 CI、官方离线样本、Windows/Web/桌面与打包入口由最终门禁验收。
- 测试数量、跳过项、CI Run ID 与性能数据以最终 `V006-TEST-RESULTS.md` 为准；未定稿处写“以最终门禁为准”。
- 不得提前宣称 Tag、Release、签名、物理设备或未运行检查已通过。
