# v0.0.5 缺陷登记

状态：Phase 0 审计建立。P0/P1 必须修复并保留“修复前失败→修复后通过”回归；P2 在不影响安全与旧功能时处理。未复现项标记 `待复现`，不得当作已确认缺陷。

| ID | 模块 | 等级 | 复现 / 证据 | 根因 | 修复方向 | 回归 / 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| V005-001 | Release | P1 | `getRelease()` 只请求 `releases?per_page=100`，超过 100 个 Release 时可能找不到目标 Draft | 缺少分页遍历 | 按 Link header 完整分页，拒绝同 Tag 多 Release | 分页、多页、重复 Tag 故障注入 | 已修复 |
| V005-002 | Release | P1 | 发行脚本无显式 Release ID 参数，无法在恢复时绑定已核验 Draft | 仅按 Tag 查找 | 增加 `--release-id`，校验 repo/tag/target_commitish/upload_url 身份 | 错误 ID、错误仓库、错误 Tag、错误 Commit 负向测试 | 已修复 |
| V005-003 | Release | P1 | API 上传与查询无限流/临时错误重试，网络中断恢复靠人工重跑 | 缺少统一 HTTP 重试层 | 403/429 Retry-After、5xx/网络指数退避、上传断点续扫 | 429、503、断流故障注入；幂等重跑 | 已修复 |
| V005-004 | Release | P1 | 残留空 Draft `458138140`，Tag 为 `untagged-fc119e89693e4cfa5197` | v0.0.4 CLI 上传失败恢复留下 | 仅删除 provenance 可证明属于 v0.0.4 的空 Draft；未知 Draft 不动 | 删除前后 API 核验；其他版本 Draft 保留 | 已修复 |
| V005-005 | Release | P1 | 正常发行流程未在公开后重新下载全部资产校验 | 仅校验 Draft 与 API digest | 增加 `verify-public` 命令与工作流步骤 | 公开地址下载、SHA256SUMS、Latest、digest 全量复验 | 已修复 |
| V005-006 | Docs | P1 | README 仍写 v0.0.4 开发中/未发布；能力矩阵仍写 Release BLOCKED | 文档未随正式发行更新 | v0.0.5 统一更新中英文 README、能力矩阵、路线图与 handoff | `docs:check`、版本检查、链接与声明扫描 | 已修复 |
| V005-007 | Parsers | P1 | 所有解析器的 64/128MB 受限堆边界尚未形成统一审计与回归 | 缺少统一内存预算矩阵 | 流式/有界审查，补长字符串、无终止符、嵌套归档、大 PCAP/USB/反编译输出回归 | 64MB/128MB 堆子进程；不得简单拒绝合理大文件 | 已拆分 V005-021/022，持续审计 |
| V005-008 | External tools | P1 | JADX/Ghidra 执行逻辑分散，冷启动、目录权限、诊断与进程回收缺少统一适配层 | 历史修补式实现 | 统一外部工具执行器，保留有界脱敏诊断与版本/来源证据 | fake tool 故障矩阵 + 官方真实 CI | 已修复 |
| V005-009 | macOS resources | P2 | `ps` 时间分量仍可能接受 `60` 分钟/秒 | 仅验证部分字段 | 严格限制 `0..59` 与有限 CPU 时间 | `00:60:60` exact Red/Green | 已修复 |
| V005-010 | Cache | P2 | cache payload 在 SQLite 事务内 rename，不是崩溃原子替换 | 文件与数据库无法单事务原子化 | 评估双槽/原子替换与 fencing，保持读取哈希校验 | 崩溃/替换/损坏回归 | 待评估 |
| V005-011 | Browser | P2 | 浏览器依赖版本漂移检查尚未实现 | 仅检查可执行文件存在 | 记录 Playwright/Chromium 版本并检测不匹配 | 版本漂移故障注入 | 待修复 |
| V005-012 | Tests | P2 | 8 项跳过测试原因分散，缺少统一平台覆盖矩阵 | 平台/外部工具条件跳过 | 建立跳过原因台账；可运行平台必须补齐 | CI 平台矩阵与 JSON 报告核对 | 已修复 |
| V005-013 | Docs | P1 | 架构/安全/API/Skill/路线图/能力矩阵存在版本与能力漂移 | 文档未随版本与发行同步 | 统一更新 v0.0.5 文档与契约，修正远程 AI 数据边界 | docs/version/Skill/OpenAPI 检查 | 已修复 |
| V005-014 | Privacy | P1 | `ARCHITECTURE.md` 声称桌面数据不出机器，但远程 AI 显式同意后会发送数据 | 隐私文案与真实行为不一致 | 明确默认本地、远程 AI opt-in、数据范围与脱敏 | 文档断言扫描 + 设置 E2E | 已修复 |
| V005-015 | Capability evidence | P1 | USB 官方样本仅解析 smoke，无预期结构断言 | 将 smoke 表述过强 | 锁定官方 URL/许可证/SHA-256 并增加记录数、设备、端点、事务、描述符已知答案 | `validate-hardware-samples.mjs` 真实下载断言 + 漂移负向测试 | 已修复 |
| V005-029 | Capability evidence | P2 | USB 热插拔无持续会话；固件缺公开样本 provenance | 未提供物理设备/合法公开固件来源 | 保持 PARTIAL/UNKNOWN，不宣称持续会话或真实设备验证 | 能力矩阵与用户指南披露；提供设备/样本后再验收 | 已接受外部限制 |
| V005-030 | Plan authorization | P1 | 内联授权未持久化，过期后执行仍按 granted=true 放行 | 执行时缺少授权记录则构造全权限 scope | 内联授权规范化持久化；执行只接受有效、未撤销、未过期且目标匹配的授权 | 撤销/过期/错误目标负向回归 | 已修复 |
| V005-031 | Plan input binding | P1 | 计划未持久化 uploadId/hash，Worker 固定选项目首上传 | 计划与执行输入无绑定 | Schema 4 增列绑定上传与哈希；无上传计划绑定 project.target；执行与 Worker 双层重校验 | 篡改、错授权、旧计划、URL 计划回归 | 已修复 |
| V005-032 | Console evidence | P1 | 用户自述证据可把主机档案提升到 C5 | 客户端证据与可信验证未区分 | 新增 USER_RECORDED/TOOL_VERIFIED；默认降级客户端声明，C2+ 仅可信验证证据 | 伪造 TOOL_VERIFIED、旧 C5 读取降级回归 | 已修复 |
| V005-033 | Remote AI policy | P1 | 项目授权 remoteAiAllowed=false 未约束 Worker 远程模型调用 | AI 调用边界仅检查全局设置 | 远程调用复核项目授权；本地 AI 不受远程共享开关误禁用 | 远程拒绝且零 fetch；本地路径保留 | 已修复 |
| V005-034 | Plan budget | P2 | 计划预算未进入执行链路，客户端可覆盖资源上限 | 执行选项未加载持久化预算 | Worker 加载计划预算并取全局硬上限 min；客户端不能扩大 | 预算与错上传回归 | 已修复 |
| V005-035 | API validation | P2 | null/畸形 body 返回 500；授权数组元素无类型/长度约束 | 新路由缺少统一输入校验 | plain-object、字符串数组、枚举、长度与数值校验，统一 400 | 畸形授权/计划回归 | 已修复 |
| V005-036 | Project deletion | P2 | 只检查最后一段，父级 junction/symlink 可逃逸 dataDir | 缺少逐组件 canonical 校验 | 逐段 lstat/realpath 并拒绝链接与越界；删除后复核根目录 | POSIX symlink 负向回归；Windows Junction 复用现有覆盖 | 已修复 |
| V005-037 | Release resume | P2 | state JSON 解析失败信息不清晰；写入非原子 | 缺少损坏状态诊断与临时文件 rename | 损坏状态明确报错；临时文件写入后原子 rename | 损坏状态与保存/加载回归 | 已修复 |
| V005-038 | Release lookup | P2 | Draft tag 端点 404 且列表端点 404 时未返回空 | 列表请求未允许 404 | tag 端点 allowNotFound，列表首页 404 返回空；保留分页与重复 Tag 校验 | 双端点 404 回归 | 已修复 |
| V005-039 | Reports | P1 | 运行中打开报告后 Markdown 不轮询、终态不刷新，导出旧快照 | report 查询与 detail 状态未联动 | report 随任务活跃状态轮询，detail 更新触发失效；导出前强制 refetch | 运行中报告、终态刷新、导出回归 | 已修复 |
| V005-040 | Privacy UI | P1 | 无条件显示“数据不出机”，与远程 AI 配置冲突 | 隐私徽标未读取设置 | 动态显示 AI/远程共享边界，加载与错误保持保守未知 | 远程 AI 徽标 E2E | 已修复 |
| V005-041 | Onboarding | P1 | 首次安全提示可跳过且无需确认 | 完成状态未绑定安全确认 | 安全内容强制展示并明确确认后才可继续/关闭 | 首次确认、Escape、设置重看 E2E | 已修复 |
| V005-042 | Wizard retry | P2 | 失败重试重复创建 project/upload/auth/plan/execute | 已成功步骤未保存 | 保存进度并从失败步骤续做；执行幂等返回原任务 | 计划失败重试不重复创建 E2E | 已修复 |
| V005-043 | Console form | P2 | 后台 refetch 覆盖未保存表单 | 缺少 dirty 保护 | dirty 状态保护与可见提示，背景刷新不覆盖编辑 | dirty 编辑 E2E | 已修复 |
| V005-044 | Report export | P2 | HTML 导出无 pending/error 状态 | 异步导出未纳入 mutation | 统一 mutation、禁用 pending、错误重试 | HTML 导出 E2E | 已修复 |
| V005-045 | Worker adapter mapping | P1 | Worker 直接比较 analyzer ID 与 adapter 名称，APK/USB 计划必然失败 | `jadx`/`usb` 与 `apk`/`hardware` 未映射 | 增加固定 analyzer→adapter 映射并校验授权接口 | APK/USB 计划真实 Worker 回归 | 已修复 |
| V005-046 | Console API validation | P2 | console 新路由畸形 body 返回 500 | 领域校验错误未映射 HTTP 状态 | diagnose/profile 校验错误统一 400 | null/数组/非法字段回归 | 已修复 |
| V005-047 | Web unsaved changes | P2 | 主机档案 dirty 时刷新/侧栏离开无保护；向导切换设置可能沿用旧进度 | 缺少统一离开确认与进度失效 | beforeunload/链接点击确认；模式、类别、项目、输入切换清理进度 | 相关 E2E 与静态检查 | 已修复 |
| V005-016 | Project deletion | P1 | 文件先删、DB 事务后提交，DB 失败可能留下文件已删记录仍在的不一致 | 跨文件与 DB 无恢复日志 | 与 V005-023 合并为同一缺陷，统一复现与修复 | DB 故障注入与恢复回归 | 已合并至 V005-023 |
| V005-017 | README | P2 | 缺少真实下载表、截图、六种使用方式与当前版本发布状态 | README 仍按开发分支维护 | v0.0.5 重写并校验真实资产/截图 | 链接、版本、资产名检查 | 已修复 |
| V005-018 | API docs | P2 | API 指南仍写 MCP 10 工具，未覆盖现有 21 工具与硬件/Op/Firmware | 文档未随工具扩展 | 同步完整工具表与错误/预算契约 | 文档与 tools.ts 数量/名称一致性测试 | 已修复 |
| V005-019 | UI docs | P2 | Settings 中 Skill 示例仍为 0.0.3 | 版本字符串硬编码 | 使用当前版本或动态能力信息 | UI E2E/版本检查 | 已修复 |
| V005-020 | Security docs | P2 | `SECURITY.md` 仅 12 行，未覆盖 v0.0.5 硬件/AI/设备/报告边界 | 安全文档未随攻击面扩展 | 完善支持版本、报告渠道、默认只读与禁止操作 | 文档审查与链接检查 | 已修复 |
| V005-021 | Network HAR | P1 | `network.ts:92-97` 将整个有界 HAR Buffer 转字符串并 `JSON.parse`；纯内存环境已复现 OOM，退出码 134 | 大 JSON 全量物化 | 流式遍历 `log.entries`，单条目有界，超限条目跳过并标记 truncated | 64/128MB 堆、大 HAR/超长字符串/畸形 JSON 回归 | 已修复 |
| V005-022 | Hardware usbmon | P1 | `hardware/index.ts:25` 全量 `toString`，`capture.ts:138` 全量 `split('\\n')`；纯内存环境已复现 OOM，退出码 134 | 大文本全量物化 | 流式逐行解析，限制行宽/记录数，保留有界诊断 | 64/128MB 堆、长行/无终止符/大量记录回归 | 已修复 |
| V005-023 | Project deletion | P1 | `server.ts:96` 先删除 uploads/tasks/cache 文件，再执行 DB 事务；DB 失败会留下文件已删、记录仍在 | 跨文件与 DB 无恢复日志 | DB 事务先写删除意图并删除记录，再清理文件；启动时恢复未完成清理 | DB 故障注入与恢复回归 | 已修复 |
| V005-024 | Release publish | P1 | 公开后校验失败会把 Release 改回 Draft，GitHub 无原子回滚，可能造成 Latest 抖动 | 误把回滚当原子补偿 | 公开后失败只报告并保留现场，禁止自动回 Draft | 发布后故障注入；确认无反向 PATCH | 已修复 |
| V005-025 | Release Tag | P1 | CLI 候选校验使用 `skipTagCheck=true`，未验证 annotated Tag 对象与解引用 Commit | 本地 Tag 可能缺失/过期 | 增加 GitHub annotated Tag 对象与 dereference 校验 | 错误 Tag 类型/错误 Commit 负向测试 | 已修复 |
| V005-026 | Release concurrency | P2 | 脚本本身无本地锁，依赖 workflow concurrency | 缺少进程级互斥 | 增加 state lock 与 stale lock 恢复 | 双进程并发测试 | 已修复 |
| V005-027 | Release upload URL | P2 | upload_url 仅校验路径/协议，未校验 host | 缺少 host allowlist | 仅允许 uploads.github.com、loopback 或显式配置 host | 恶意 host 负向测试 | 已修复 |
| V005-028 | Release historical verify | P2 | `verify-public` 强制 Latest，无法复核历史版本 | 当前版与历史版口径混用 | 增加 requireLatest 参数，历史复验默认关闭 | 历史 Release 复验测试 | 已修复 |

## 新增功能缺口（非缺陷，进入 V005-PLAN）

- Console Research Lab、C0-C5 能力等级与设备档案。
- 智能逆向向导、自动分析计划引擎、分析器管理中心。
- AI V3 多角色受限工作流与完整预算。
- 内置自动化验收实验室、普通用户/专业双视图报告。
- 统一授权范围管理中心、首次使用声明与隐私默认值。
- MCP/Skill/CLI/API/Web/Desktop 全入口同步。
