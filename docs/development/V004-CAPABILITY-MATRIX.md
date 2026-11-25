# v0.0.4 历史功能验收矩阵

状态定义：IMPLEMENTED=有真实实现；VERIFIED=有可重复真实验收；PARTIAL=只覆盖部分链路；MOCK_ONLY=仅模拟/替身；BLOCKED=外部依赖阻塞；MISSING=未实现；REGRESSION=相对历史承诺退化。

| 能力 | 状态 | 实现证据 | 验收边界 / v0.0.4 动作 |
|---|---|---|---|
| PE/ELF/Mach-O 元数据 | VERIFIED | `packages/core/src/adapters/file.ts:9-29`；`deep-adapters.test.ts` | 头、section、import、熵、字符串；不是反编译 |
| Ghidra headless 进程链 | PARTIAL | `adapters/ghidra.ts:166-227` | fake headless 与故障注入通过；需 CI 真实 Ghidra/JDK |
| Ghidra 伪代码 | MISSING | `ghidra.ts:220,225` 明确排除 | v0.0.4 增加 DecompInterface 导出和已知函数对照 |
| Ghidra 调用图 | MISSING | 同上 | v0.0.4 增加有界调用关系 |
| Ghidra 字符串引用 | MISSING | 仅导出字符串值 | v0.0.4 增加 address/reference |
| Ghidra Windows 启动 | PARTIAL | `.bat/.cmd` 被拒绝，`ghidra.ts:168-169` | 增加直接可执行 Node launcher，CI 真实验收 |
| APK ZIP 安全清单 | VERIFIED | `apk.ts:68-99`；APK 测试 | 边界、压缩比、条数、流式读取 |
| 二进制 AXML Manifest | VERIFIED | `apk.ts:151-164` | package/permission 候选，不执行应用 |
| DEX 元数据 | VERIFIED | `apk.ts:107-130` | string/type/proto/method/class 表；无指令反编译 |
| JADX/等效 Android 反编译 | MISSING | `apk.ts:206` 明确 no decompiler | v0.0.4 按需真实工具 CI 验收 |
| HAR | VERIFIED | `network.ts:92-124` | URL/头名/大小/状态；不保留 body/cookie 值 |
| PCAP/PCAPNG | VERIFIED | `network.ts:205-240` | Ethernet/Linux cooked/raw IP；USB 不是同一解析器 |
| 多页面网页采集 | VERIFIED | `website.ts:181+`；真实 Chrome 测试 | 同源、maxPages、弹窗、状态转移 |
| 网站动态兼容重建 | MISSING | `website.ts:157` compatibility 为静态 preview | v0.0.4 不得宣称完整网站克隆；补行为对比 |
| 游戏 L4 | VERIFIED | 67 项 game-state-safety + 真实生成 child process | 独立兼容服务，保留 logout 轮换/凭证脱敏/旧状态迁移 |
| 游戏 L5 | MISSING | 无独立兼容实现 | 仅在有真实条件时评估，不作为 v0.0.4 默认承诺 |
| AI Planner | PARTIAL | `engine.ts:198-208` steps 只写证据 | v0.0.4 实现受限的 plan→execute 或明确保持咨询 |
| AI Interpreter | VERIFIED（协议） | `engine.ts:213-218` | fake OpenAI-compatible server 验证；无真实 Key 时不是真实模型验收 |
| AI Validator/ bounded repair | PARTIAL | `engine.ts:220-238` | 仅一次 deterministic reconstruct；不是自动代码修复 |
| 静态安全规则 | VERIFIED | `security.ts`、security tests | 正负样本、SARIF、CWE 候选 |
| 在线 OSV 漏洞匹配 | BLOCKED | v0.0.3 明确禁用 | 不在本轮假装启用；SBOM+本地规则保留 |
| 证据知识库 | VERIFIED | API search/detail、Web E2E | 分页、过滤、关系；大列表仍可优化 |
| Schema 3 迁移 | VERIFIED | migrations + backup tests | 中断/损坏/锁/重复迁移 |
| 备份恢复 | VERIFIED | BackupService + API/CLI/Web | 隔离恢复、哈希、quick_check |
| Worker lease/fencing | VERIFIED | workflow 64 项 | 双进程 claim、过期执行、暂停取消、GC/prune |
| 项目删除竞态（单 API） | VERIFIED | `project-delete-race.test.ts` | 进程内锁；多实例边界需明确 |
| 工件不可变发布 | VERIFIED（安全） | workflow/artifact tests | 同步 hash 阻塞事件循环，v0.0.4 P1 |
| 私有快照读取 | PARTIAL | `evidence.ts:54-63` | POSIX 0600；Windows ACL/Junction 专项不足 |
| Windows Junction/Reparse | MISSING | 3 个 symlink 测试跳过 | v0.0.4 必须补 Windows 专用回归 |
| 资源采样 | PARTIAL | `resources.ts` | 平台采样、TTL、迟滞；失败分类过粗 |
| 桌面完整进程树 | MISSING | 无 `sample('desktop')` 调用 | v0.0.4 增加真实 sidecar/桌面总内存 |
| 缓存 | VERIFIED（正确性） | cache concurrency/corruption/scope tests | 热 P95 异常未归因 |
| EXE 安装/便携 | VERIFIED（CI） | v0.0.3 candidate Windows smoke | 本轮需重跑；未签名限制保留 |
| CLI TGZ | VERIFIED（CI） | 干净全局安装 smoke | CLI 命令覆盖不完整 |
| Server TGZ | VERIFIED（CI） | 解包、npm ci、启动、健康检查 | 本轮需重跑 |
| MCP stdio | VERIFIED | platform integration 17 工具 | 无硬件工具 |
| MCP Streamable HTTP | VERIFIED | platform integration loopback auth | 不得授予远程 USB 权限 |
| Skill | VERIFIED（结构/环境） | validate/package/check-environment | 缺硬件/固件工作流说明 |
| REST API/OpenAPI | VERIFIED | 42 paths contract test | 新硬件 API 需同步契约 |
| Docker | VERIFIED（CI） | v0.0.3 candidate health | 默认无 USB；不得 privileged |
| USB Windows 枚举 | MISSING | 无实现 | v0.0.4 H0，系统 CIM/PnP 只读 |
| USB Linux 枚举 | MISSING | 无实现 | v0.0.4 sysfs 描述符/拓扑 |
| USB 热插拔 | MISSING | 无实现 | 身份哈希重新核验，禁止继承授权 |
| USB PCAP/USBPcap | MISSING | network adapter 不支持 DLT_USB* | v0.0.4 独立 hardware parser |
| Linux usbmon 文本 | MISSING | 无实现 | v0.0.4 t/u 格式，区分 Windows |
| HID 报告描述符 | MISSING | 无实现 | Linux sysfs + 离线描述符解析；键盘默认禁采 |
| 串口枚举 | MISSING | 无实现 | Windows CIM/Linux sysfs 只读列表 |
| 串口实时读取 | MISSING | 无实现 | 仅本地显式选择；DTR/RTS 默认不变 |
| 固件 BIN/IMG | MISSING | 无实现 | 魔数、熵、字符串、布局、哈希 |
| Intel HEX | MISSING | 无实现 | 有界流式地址区域 |
| UF2 | MISSING | 无实现 | 块校验、family、地址区域 |
| ELF 固件 | PARTIAL（文件元数据） | file adapter | 复用架构/section，不执行 |
| 固件归档/文件系统识别 | MISSING | file adapter 仅 ZIP 清单 | 只识别签名，不自动解包执行 |
| 固件 SBOM/风险 | MISSING | file adapter 仅 package.json SBOM | 组件线索、置信度、脱敏、UNKNOWN |
| 硬件物理设备验收 | BLOCKED | 无用户指定设备和捕获授权 | 仅执行系统只读枚举；不访问所有连接设备 |
| 实时 USB 捕获 | BLOCKED | 需驱动/权限/指定设备 | v0.0.4 默认不启动全总线捕获 |
| README/品牌/真实截图 | MISSING | 无图片资产 | v0.0.4 强制重写并从真实运行截图 |
