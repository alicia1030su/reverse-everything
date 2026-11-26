# v0.0.5 全量基线审计

审计日期：2026-11-25。审计方式：只读核查本地仓库、GitHub API、测试 JSON 报告、性能基准与关键源码。所有历史数字均重新采集，不直接沿用 v0.0.4 总结。

## 1. 仓库与分支状态

| 项目 | 审计结果 |
|---|---|
| 本地 main | `b2590423328b3ca379c349d987561ee9afae63d1` |
| 远端 main | `b2590423328b3ca379c349d987561ee9afae63d1` |
| 工作树 | 仅 `artifacts/` 为未跟踪审计产物；源码无未提交修改 |
| 未合并 PR | 0 |
| 现有 Issue | 0 |
| main 保护规则 | 0；当前未配置 required status checks/branch protection |
| 本地 Tag 完整性 | 本地仅部分 Tag/对象，发行脚本不能依赖本地 Tag，必须通过 GitHub API 校验 annotated Tag |
| 当前版本 | `VERSION=0.0.4`，`package.json=0.0.4`，contracts `VERSION=0.0.4` |
| Schema | 3 |
| Workspace | 9 个 package + 5 个 app |

## 2. Tag、Release 与资产来源

| 项目 | 审计结果 |
|---|---|
| 正式 Tag | `v0.0.4` |
| Tag 类型 | annotated |
| Tag object | `bcf991f5b21e51ef83756e08ef98d32ccdcc276c` |
| Tag 解引用 Commit | `cfb19bbfa23d67ed23b660c793602bcadc1cffa6` |
| Release ID | `458138243` |
| Release 状态 | `draft=false`、`prerelease=false`、GitHub Latest |
| 发布时间 | `2026-11-25T13:16:14Z` |
| 资产数 | 12 |
| 候选 Run | `45611613592` |
| 候选 artifact | `candidate-0.0.4`，ID `15020362746`，236,816,532 字节，SHA256 `7a2ef562e28185623b576cf58bbcae457b832928492d4355d1f575b807901910` |
| 发行恢复 Run | `45622020772`，全绿 |
| Manifest SHA256 | `ccab9042c24e6d7e278b566e316693950367f89ec6400dc4663233778fa83fe0` |

12 个公开资产均可在 `RELEASE-MANIFEST.json` 与 `SHA256SUMS.txt` 中追溯；GitHub Release digest 与清单逐项一致。资产包括 Windows EXE/Portable、CLI/Server/Skill、OpenAPI、SBOM、Docker 元数据及 provenance 控制文件。

### 残留 Draft 缺陷

仓库仍存在一个空 Draft：

- ID：`458138140`
- Tag：`untagged-fc119e89693e4cfa5197`
- 资产数：0
- Body：与 v0.0.4 恢复 Draft 相同，provenance marker 一致

这是 v0.0.4 恢复期间 CLI 上传行为留下的无效 Draft，属于 V005-004。不得删除其他版本或未知来源 Draft。

## 3. v0.0.4 Tag 与发布后 main 差异

`cfb19bb..b259042` 共 7 个提交、8 个文件：

- `scripts/release-atomic.mjs`：Draft 列表回退与按 Release ID `upload_url` 上传修复。
- `tests/unit/release-atomic.test.ts`：Draft 查找与上传 URL 回归。
- 6 份 V004 文档：最终发行证据回填。
- 临时恢复工作流已添加后删除，不在最终 main。

结论：v0.0.4 的发行脚本修复已完整进入 main，但仍缺分页、显式 Release ID 校验、限流/重试、断点恢复和正常流程的发布后重新下载验证。

## 4. 测试基线

命令：`npm test -- --reporter=json --outputFile=artifacts/v005-baseline-tests.json`

| 指标 | 结果 |
|---|---|
| Test files | 50 passed |
| Total | 536 |
| Passed | 528 |
| Pending/skipped | 8 |
| Failed | 0 |

### 8 项跳过测试

| 文件 / 用例 | 原因 | 处理结论 |
|---|---|---|
| `api-safety.test.ts` artifact symlink | `skipIf(win32)`，POSIX 符号链接安全用例 | Linux CI 覆盖；Windows 使用 Junction/Reparse 专项 |
| `android-real.test.ts` real JADX | 仅 `RE_RUN_ANDROID_REAL=1` 启用 | 官方 JADX workflow 已覆盖；本地保留按需真实测试 |
| `artifact-read-safety.test.ts` symlink | `skipIf(win32)` | Linux CI 覆盖 |
| `deep-adapters.test.ts` external JADX home | `runIf(!win32)`，依赖 POSIX 可执行 fake Java | Linux CI 覆盖；Windows 真实 JADX 路径另行验收 |
| `deep-adapters.test.ts` JADX output symlink | `runIf(!win32)` | Linux CI 覆盖 |
| `hardware-enumerate.test.ts` sysfs permission | `skipIf(win32)` | Linux CI 覆盖 |
| `upload-read-safety.test.ts` symlink | `skipIf(win32)` | Linux CI 覆盖 |
| `windows-file-safety.test.ts` final symlink | Windows 无符号链接权限时 `EPERM` 跳过 | Junction 与 canonical alias 已覆盖；保留诚实跳过说明 |

这些跳过均有明确平台或外部工具原因，不是删除测试或降低断言。V005 将保留原因，并在可运行平台补足证据。

## 5. 性能与缓存基线

命令：`node scripts/benchmark.mjs --engine --samples 7 --warmup 2 --output artifacts/v005-baseline-benchmark.json`

| 指标 | 结果 |
|---|---|
| 失败任务 | 0 |
| Cold P95 | 271.29 ms |
| Hot P95 | 181.04 ms |
| Cold cache hit rate | 0 |
| Hot cache hit rate | 1.0 |
| Hot writes | 0 |
| Peak RSS | 144.21 MB |
| Peak heap used | 53.43 MB |
| GC pause P95 | 0.0117 ms |
| SQLite quick_check | ok |

结论：v0.0.4 的缓存热路径重复写入、桌面总内存采样和资源分类问题在当前基线上未复现；历史性能缺陷已有可重复证据关闭。V005 新增模块必须保持空闲内存不显著增加，并复跑同一基准。

### 已复现 P1 内存缺陷

独立代码审计在纯内存环境实际复现两个 OOM（退出码 134）：

- HAR：`packages/core/src/adapters/network.ts:92-97` 全量 Buffer→string→JSON.parse。
- usbmon：`packages/hardware/src/index.ts:25` 全量转字符串，`packages/hardware/src/capture.ts:138` 全量 split。

两者进入 Wave 2 优先修复，补 64/128MB 受限堆回归。

## 6. 能力与验证等级

| 能力 | 当前状态 | 证据边界 |
|---|---|---|
| Ghidra 12.2 PE/ELF 已知答案 | VERIFIED | 官方 Ghidra/JDK + 自编译 PE/ELF；不是官方二进制样本，不覆盖所有架构/格式 |
| JADX 1.5.3 APK 已知答案 | VERIFIED | 官方 JADX archive + 确定性合成 APK；不是真实第三方 APK |
| USB Windows/Linux 枚举 | IMPLEMENTED | 只读系统枚举；不打开设备 |
| USB PCAP/PCAPNG/usbmon/HID 离线分析 | IMPLEMENTED（smoke） | Wireshark 官方样本 3/3 解析通过，但缺少预期结构断言；不保留原始 payload |
| 固件 BIN/HEX/UF2/ELF/ZIP 静态分析 | IMPLEMENTED（合成 fixture） | 自建已知答案与恶意输入；公开固件样本来源/SHA 尚未建立 |
| USB 热插拔身份 | PARTIAL | 纯内存 reducer 与离线快照比较；无持续会话/授权持久化 |
| 真实物理 USB/串口/实时捕获 | BLOCKED | 未提供指定设备与授权 |
| 游戏 L4 兼容服务 | IMPLEMENTED | 独立兼容服务，不是原始服务端恢复 |
| AI Planner/Validator | PARTIAL | 受限咨询与结构化计划，不是自主 Agent |
| 主机研究实验室 | MISSING | v0.0.5 新增 |
| 智能逆向向导 | MISSING | v0.0.5 新增 |
| 自动分析计划引擎 | MISSING | v0.0.5 新增 |
| AI V3 多角色工作流 | MISSING | v0.0.5 新增 |
| 普通用户/专业双视图报告 | MISSING | v0.0.5 新增 |
| 授权范围管理中心 | MISSING | v0.0.5 新增 |

## 7. 文档与契约一致性

发现以下过期或冲突：

- `README.md:3,13` 仍写“v0.0.4 开发分支”“不表示 Tag 或正式 Release 已发布”，与公开 Release 事实冲突。
- `README.md` 没有 v0.0.4 下载表、真实截图或六种使用方式；用户无法从 README 直达已发布资产。
- `docs/development/V004-CAPABILITY-MATRIX.md:97` 仍写 v0.0.4 Release `BLOCKED`。
- `.ai-memory/handoff.md` 仍停留在 v0.0.4 候选阶段。
- `docs/ROADMAP.md:5-8,15-17` 仍把 v0.0.5 描述为“移动应用深化”，与当前权威需求锁定卡冲突。
- `docs/ARCHITECTURE.md:139` 仍写“桌面数据不出机器”，与远程 AI 显式同意后的数据出机行为冲突。
- `docs/SECURITY-MODEL.md:35` 仍写支持 v0.0.3。
- `docs/user-guide/API.md:87-105` 仍写 MCP 10 工具，未覆盖硬件、Op/Firmware 与现有 21 工具。
- `docs/user-guide/SKILL.md:60` 的脚本列表仍写 0.0.3。
- `apps/web/src/pages/Settings.tsx:245` 的 Skill 示例仍写 0.0.3。
- `SECURITY.md` 仅 12 行，缺少 v0.0.5 所需的硬件、AI、设备连接与报告限制。
- 中英文 README 的下载表、版本号、能力状态和未验证声明需在 v0.0.5 统一重写。

## 8. 发行脚本剩余缺口

- Draft 查找只读取第一页 100 条，未实现完整分页。
- 未接受显式 `--release-id`，也未校验 Release ID 与仓库/Tag/Commit 的绑定。
- GitHub API 请求缺少 403/429 限流处理、Retry-After、指数退避和临时 5xx 重试。
- 上传中断后仅靠重新扫描资产恢复，没有持久化 resume 状态。
- 正常发行流程缺少发布后从公开地址重新下载并校验的步骤。
- 对残留 `untagged-*` 空 Draft 没有安全识别和清理机制。
- 发行工作流仍为 v0.0.4 专用，需要 v0.0.5 版本化流程。

## 9. 审计结论

v0.0.4 的代码、测试、真实工具和正式发行基线总体可信；当前主要风险集中在发行脚本边界、文档过期、解析器内存审计、外部分析器统一适配，以及 v0.0.5 新能力尚未实现。Phase 0 结论可作为 V005-PLAN 的输入。
