# v0.0.5 能力验收矩阵

最后更新：2026-11-25。状态以代码、测试、CI 与公开发行为准；实现状态与证据等级分离。

## 状态定义

- 实现状态：`IMPLEMENTED`、`VERIFIED`、`PARTIAL`、`BLOCKED`、`MISSING`、`REGRESSION`。
- 证据等级：`EVIDENCE`、`INFERENCE`、`UNKNOWN`、`VERIFIED`。
- 主机研究等级：C0 档案、C1 身份与官方资料记录、C2 合法接口、C3 静态分析、C4 授权开发环境实测、C5 自有设备独立兼容实现。C2 及以上仅 `TOOL_VERIFIED` 证据可提升。

## 既有平台能力

| 能力 | 状态 | 证据 | v0.0.5 要求 |
|---|---|---|---|
| 九类 Web 入口 | IMPLEMENTED | `NewProject.tsx`、contracts、core adapters | 增加主机/向导入口，不破坏旧路由 |
| PE/ELF/Mach-O 静态分析 | IMPLEMENTED | `file` adapter | 纳入自动计划 |
| Ghidra 12.2 已知答案 | VERIFIED | 官方 Ghidra/JDK + 自编译 PE/ELF | 统一工具执行适配层，保留真实 CI |
| JADX 1.5.3 已知答案 | VERIFIED | 官方 JADX archive + 确定性合成 APK | 统一工具执行适配层 |
| 网页多页面采集 | IMPLEMENTED | `website` adapter、真实 Chrome | 纳入小白模式 |
| HAR/PCAP/PCAPNG | IMPLEMENTED | `network` adapter | 大文件受限堆回归 |
| USB PCAP/USBMon/HID 离线 | VERIFIED（公开样本） | Wireshark 官方样本 3/3；URL/许可证/SHA-256 与记录数、设备、端点、事务、描述符已知答案断言通过 | 大记录受限堆回归；不外推物理设备 |
| USB/串口只读枚举 | IMPLEMENTED | Windows CIM/PnP、Linux sysfs | 复用为连接诊断，不打开设备 |
| USB 热插拔身份 | PARTIAL | 纯内存 reducer 与离线快照比较 | 无持续会话/授权持久化 |
| 固件静态分析 | IMPLEMENTED（合成 fixture） | `firmware` package/adapter | 公开固件样本来源/SHA 尚未建立 |
| 游戏 L4 | IMPLEMENTED | `game` adapter | 纳入内置演示，不宣称原始服务端恢复 |
| Schema 4/备份恢复 | IMPLEMENTED | migrations/backup | 新表迁移、删除意图与恢复 |
| Worker lease/fencing | IMPLEMENTED | engine/database | 全量回归 |
| Windows ACL/reparse | IMPLEMENTED | evidence package | 全量回归 |
| Docker | IMPLEMENTED | compose/CI | 保留无 USB、无 privileged |

## 主机研究实验室

| 设备类型 | C0 档案 | C1 资料记录 | C2 接口（需验证） | C3 静态分析（需验证） | C4 开发环境（需验证） | C5 独立兼容（需验证） | 边界 |
|---|---|---|---|---|---|---|---|
| PlayStation 5 | IMPLEMENTED | 需证据 | 需授权 | IMPLEMENTED | BLOCKED | BLOCKED | 不越狱、不提权、不绕安全启动/DRM |
| PS5 Slim | IMPLEMENTED | 需证据 | 需授权 | IMPLEMENTED | BLOCKED | BLOCKED | 同上 |
| PS5 Pro | IMPLEMENTED | 需证据 | 需授权 | IMPLEMENTED | BLOCKED | BLOCKED | 同上 |
| PlayStation 4 | IMPLEMENTED | 需证据 | 需授权 | IMPLEMENTED | BLOCKED | BLOCKED | 同上 |
| Xbox Series X/S | IMPLEMENTED | 需证据 | Developer Mode 指引 | IMPLEMENTED | BLOCKED | BLOCKED | Developer Mode 不等于 Retail 全权限 |
| Xbox One | IMPLEMENTED | 需证据 | Developer Mode 指引 | IMPLEMENTED | BLOCKED | BLOCKED | 同上 |
| Android TV/盒子 | IMPLEMENTED | ADB 授权时读取 | 官方 ADB | IMPLEMENTED | BLOCKED | BLOCKED | 未授权即停止，不绕认证/锁屏 |
| 其他开放嵌入式设备 | IMPLEMENTED | 手填/只读枚举 | 合法开放接口 | IMPLEMENTED | BLOCKED | BLOCKED | 不发送未知指令 |

USB Type-C 仅作为物理连接信息记录，不能作为调试能力或电气安全依据。

## 智能分析与自动化

| 能力 | 状态 | 验收标准 |
|---|---|---|
| 小白模式 | IMPLEMENTED | 无终端操作即可选择对象、确认授权、运行、理解状态、查看/导出报告 |
| 专业模式 | IMPLEMENTED | 可选择分析器、深度、输出、模型和预算 |
| AI Agent 模式 | IMPLEMENTED | MCP/Skill/API/CLI 共用后端授权、Schema、预算与结构化错误 |
| 自动检测 | IMPLEMENTED | OS、文件类型、架构、平台、固件格式、接口、工具、资源、授权 |
| 自动选择分析器 | IMPLEMENTED | 不可用时说明原因、官方安装指引、安全替代、继续可完成阶段 |
| 自动任务计划 | IMPLEMENTED | 目标识别→环境检测→授权→匹配→计划→执行→证据→验证→报告 |
| 分析工具管理器 | PARTIAL | 能力检测与官方指引已实现；大型工具下载/安装需显式确认 |
| AI V3 | IMPLEMENTED（受限） | 动态角色、并发上限、工具调用 Schema/权限/预算、无进展停止 |
| 执行预算 | IMPLEMENTED（计划层） | 时间、工具调用、模型迭代、Token、费用、内存、磁盘、取消、恢复 |
| 内置演示 | IMPLEMENTED | 网页、游戏、APK、UF2、USB、HAR、安全样本 |
| 双视图报告 | IMPLEMENTED | 普通用户/专业视图切换，Markdown/JSON/HTML 导出 |
| 授权范围中心 | IMPLEMENTED | 目标、范围、接口、操作、数据、有效期、远程 AI 同意统一记录 |

## 全入口契约

| 入口 | v0.0.5 能力 |
|---|---|
| REST/OpenAPI | console、plans、wizard 相关授权、tools、demos、authorizations、plain report |
| MCP | 37 个工具，覆盖主机、授权、计划、工具、演示与报告 |
| CLI | console、plans、tools、demos、authorizations、plain report |
| Skill | 指导普通 AI 客户端使用智能分析流程与安全边界 |
| Web | 主机实验室、向导、计划、工具中心、演示、双视图报告、授权中心 |
| Desktop | 复用 Web + 首次使用提示；不新增宿主权限 |
| Docker | 保留离线/只读边界，不映射 USB |

## 未验证与阻塞

- PS5/Xbox/Android TV 真实设备未提供：C1/C2/C4/C5 不得标 VERIFIED。
- 无代码签名证书：Windows 安装包保持未签名并披露。
- macOS、物理设备、实时捕获、驱动安装、刷写未授权。
- 真实 AI 模型可选验收；无 Key 时确定性计划与规则分析必须完整可用。
