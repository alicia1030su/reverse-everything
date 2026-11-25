# v0.0.4 能力验收矩阵

最后更新：2026-11-25。状态以当前分支代码与最终门禁为准；本表不代替 `V004-TEST-RESULTS.md`。

状态定义：`IMPLEMENTED`=有真实实现；`VERIFIED`=有可重复真实验收；`PARTIAL`=只覆盖部分链路；`BLOCKED`=外部依赖/权限阻塞；`MISSING`=未实现；`REGRESSION`=相对历史承诺退化。实现状态与证据等级（`EVIDENCE` / `INFERENCE` / `UNKNOWN` / `VERIFIED`）分离。

## 入口与平台

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| 九类 Web 入口 | IMPLEMENTED | `apps/web/src/pages/NewProject.tsx` | Web ids：website/software/android/game/network/security/usb/firmware/board；usb 映射 hardware；board 复用 `hardware`，固件镜像使用 `firmware` |
| 项目/Adapter 契约 | IMPLEMENTED | `packages/contracts/src/index.ts`；`packages/core/src/index.ts` | 7 种项目 kind、9 个 adapter；最终全入口测试以门禁为准 |
| CLI | IMPLEMENTED | `apps/cli/src/cli.ts` | health/capabilities/projects/analyze/tasks/report/hardware/firmware/analyzers/resources/cache/retention/mcp；按 `--help` 核对 |
| MCP 21 工具 | IMPLEMENTED | `apps/cli/src/tools.ts` | stdio + Streamable HTTP；无清理、设备打开、实时捕获或刷写 |
| REST/OpenAPI v0.0.4 | IMPLEMENTED | `apps/api/src/server.ts`；`scripts/generate-openapi.mjs` | `/api/v1` 与 `/api` 同路由；最终契约测试以门禁为准 |
| Skill | IMPLEMENTED | `skills/reverse-everything/SKILL.md` | 结构/环境检查通过；九类工作流与硬件边界已纳入 |
| Windows 桌面 | IMPLEMENTED | `apps/desktop/src/main.ts`；`metrics.ts` | 安装/便携、neutral CWD、真实 Electron smoke 以最终门禁为准 |

## 软件、Android 与外部工具

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| PE/ELF/Mach-O 元数据 | IMPLEMENTED | `packages/core/src/adapters/file.ts` | 头、section/import、熵、字符串；不是反编译 |
| Ghidra Headless 进程链 | VERIFIED（CI 已知答案） | `packages/core/src/adapters/ghidra.ts` | 官方 Ghidra 12.2/JDK25 Ubuntu PE/ELF 与 Windows PE 通过 |
| Ghidra 伪代码 | VERIFIED（CI 已知答案） | `ghidra.ts` DecompInterface/postScript | 已知函数伪代码通过；不覆盖所有架构/格式 |
| Ghidra 调用图 | VERIFIED（CI 已知答案） | `ghidra.ts` 直接调用边/postScript | 已知直接调用边通过 |
| Ghidra 字符串引用 | VERIFIED（CI 已知答案） | `ghidra.ts` address/reference 类型 | 已知字符串 address/function 引用通过 |
| Ghidra Windows/打包启动 | VERIFIED（Windows CI）/候选包复验 | `scripts/ghidra-analyze-headless.mjs`；打包脚本 | Windows Node launcher 官方 CI 通过；最终 Server/Desktop 包由 release workflow smoke |
| APK ZIP 安全清单 | IMPLEMENTED | `packages/core/src/adapters/apk.ts` | 条数、压缩比、路径、流式/完整性边界；最终回归以门禁为准 |
| AXML Manifest | IMPLEMENTED | `apk.ts` | package/permission 候选，不执行应用 |
| DEX 元数据 | IMPLEMENTED | `apk.ts` | string/type/proto/method/class 表；无指令级完整反编译声明 |
| JADX/等效 Android 反编译 | VERIFIED（CI 已知答案） | `apk.ts` 真实进程链 | 官方 JADX 1.5.3 archive、真实 Java/方法/字符串/Manifest/资源与生产适配器测试通过 |
| iOS 深度分析 | MISSING | 无对应 adapter | 不在 v0.0.4 默认承诺 |

## 网页、协议与游戏

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| 多页面网页采集 | IMPLEMENTED | `packages/core/src/adapters/website.ts` | 同源、maxPages、弹窗、状态转移；真实 Chrome 结果以最终门禁为准 |
| 网站动态兼容重建 | PARTIAL | `website.ts` compatibility preview | 不是原后端或完整动态网站克隆 |
| HAR | IMPLEMENTED | `packages/core/src/adapters/network.ts` | URL/头名/大小/状态；不保留 body/cookie 值 |
| PCAP/PCAPNG | IMPLEMENTED | `network.ts` | Ethernet/Linux cooked/raw IP；USB 使用独立 hardware parser |
| 游戏 L4 | IMPLEMENTED | `packages/core/src/adapters/game.ts` | 独立兼容服务，不是原始服务端恢复 |
| 游戏 L5 | MISSING | 无独立兼容实现 | 仅在有真实条件时评估 |
| AI Planner | PARTIAL | `packages/workflow/src/engine.ts` | 受限计划/咨询，不宣称自主执行 |
| AI Interpreter | IMPLEMENTED（协议） | `engine.ts` | fake model 测试不是真实模型验收 |
| AI Validator/bounded repair | PARTIAL | `engine.ts` | 不是自动代码修复 |

## 安全、缓存与运行治理

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| 静态安全规则 | IMPLEMENTED | `packages/core/src/adapters/security.ts` | 正负样本、SARIF、CWE 候选；最终结果以门禁为准 |
| 在线 OSV 漏洞匹配 | BLOCKED | 当前未启用 | 不假装启用；SBOM + 本地规则保留 |
| 证据知识库 | IMPLEMENTED | API search/detail、Web | 分页、过滤、关系；大列表优化非本轮承诺 |
| Schema 3/备份恢复 | IMPLEMENTED | `packages/workflow/src/database.ts`；migrations/backup | 隔离恢复、哈希、quick_check；最终迁移/恢复测试以门禁为准 |
| Worker lease/fencing | IMPLEMENTED | `packages/workflow/src/engine.ts` | 双进程 claim、过期执行、暂停取消、GC/prune |
| 项目删除竞态 | IMPLEMENTED | `apps/api/src/server.ts` serializeProjectMutation | 单 API 进程内串行；多实例由 runtime lease 限制 |
| 缓存正确性 | IMPLEMENTED | `packages/workflow/src/cache.ts` | scope、TTL、容量、引用计数、SHA-256、损坏 miss |
| 保留与删除 | IMPLEMENTED | `packages/workflow/src/retention.ts` | preview/apply、活动任务保护、身份复核；不自动删除上传/正式产物 |
| API/Worker 资源采样 | IMPLEMENTED | `packages/workflow/src/resources.ts` | 进程树、TTL、迟滞、失败分类；真实平台结果以门禁为准 |
| 桌面进程指标 | IMPLEMENTED | `apps/desktop/src/metrics.ts`；`apps/api/src/desktop-metrics.ts` | Electron + sidecar；缺失/陈旧/截断写入 limitations |
| Windows ACL/私有快照 | IMPLEMENTED | `packages/evidence/src/index.ts` | icacls 当前 SID、移除继承、reparse 拒绝；真实 Windows 测试以门禁为准 |
| API 单实例 | IMPLEMENTED | `Database.acquireRuntimeLease` | SQLite runtime lease；失去租约 fail-closed |
| Electron 单实例 | IMPLEMENTED | `apps/desktop/src/main.ts` | requestSingleInstanceLock；第二次启动聚焦 |
| EXE/Portable/TGZ | IMPLEMENTED（候选） | 打包脚本与 release workflow | 未签名限制保留；安装/neutral CWD/哈希以最终门禁为准 |
| Docker | IMPLEMENTED | `docker-compose.yml` | 默认无 USB、无 privileged；本轮运行证据以最终门禁为准 |

## 硬件与固件

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| USB Windows 枚举 | IMPLEMENTED | `packages/hardware/src` | CIM/PnP 只读；不打开设备，字段缺失保持 UNKNOWN |
| USB Linux 枚举 | IMPLEMENTED | `packages/hardware/src` | sysfs 描述符/拓扑；OS 权限限制如实披露 |
| USB 热插拔身份 | IMPLEMENTED | `DeviceHotplugTracker` | 稳定身份变化需重新授权，不继承授权 |
| USB PCAP/USBPcap 离线 | IMPLEMENTED | `packages/hardware/src` | 独立 DLT_USB* 解析；有界元数据，不保留原始 payload |
| Linux usbmon 文本 | IMPLEMENTED | `packages/hardware/src` | t/u 格式与平台区分；畸形输入 fail-closed |
| HID report descriptor | IMPLEMENTED | `packages/hardware/src` | 离线描述符/item 边界；键盘真实报告捕获禁用 |
| 串口枚举 | IMPLEMENTED | `apps/api/src/hardware.ts`；`packages/hardware/src` | 只读列表；不打开、不改 DTR/RTS |
| 串口实时读取 | BLOCKED | 无授权设备/交互流程 | 默认禁用，不以列表冒充实时读取 |
| 固件 BIN/IMG | IMPLEMENTED | `packages/firmware/src`；firmware adapter | 魔数、熵、字符串、布局、哈希；静态不执行 |
| Intel HEX | IMPLEMENTED | `packages/firmware/src` | 有界流式地址区域与结构校验 |
| UF2 | IMPLEMENTED | `packages/firmware/src` | 块校验、family、地址区域 |
| ELF 固件 | IMPLEMENTED | `packages/firmware/src` | 复用 section/program header；不执行 |
| 固件归档/文件系统识别 | IMPLEMENTED（签名/清单） | `packages/firmware/src` | 只识别签名/中央目录，不自动解包运行 |
| 固件 SBOM/风险 | IMPLEMENTED（线索） | firmware adapter | 组件为 INFERENCE；加密/高熵保持 UNKNOWN |
| 开发板场景 | IMPLEMENTED（路由） | Web/CLI/Skill | 复用 `hardware`；固件镜像使用 `firmware`；不虚构 board adapter 或设备权限 |
| 硬件物理设备验收 | BLOCKED | 无用户指定设备与捕获授权 | 只执行系统只读枚举，不访问全部连接设备 |
| 实时 USB 捕获/刷写 | BLOCKED | 需驱动/权限/指定设备 | 默认不启动全总线捕获，不刷写 |

## 文档与发布

| 能力 | 状态 | 实现证据 | 验收边界 / 剩余动作 |
|---|---|---|---|
| 中英文 README | IMPLEMENTED | `README.md`、`README.en.md` | v0.0.4 能力、九类入口、CLI/API/MCP、安全与未验证声明 |
| 文档链接/命令 | IMPLEMENTED | `scripts/check-docs.mjs`；CLI `--help` | `npm run docs:check` 与最终 diff 检查 |
| v0.0.4 正式 Release | BLOCKED | 尚未完成最终门禁 | 不得写“已发布”；Tag/Run ID/资产 digest 以最终结果为准 |
