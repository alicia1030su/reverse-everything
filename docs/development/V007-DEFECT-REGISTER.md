# V007 缺陷登记

更新：2026-11-26。状态：OPEN / IN_PROGRESS / FIXED / VERIFIED / EXTERNAL_BLOCKED。P0/P1 未清零不得发布 v0.0.7。

| ID | 级别 | 问题 | 根因与证据 | 修复方向 | 状态 |
| --- | --- | --- | --- | --- | --- |
| V007-001 | P1 | 游戏生成不是目标行为驱动，而是固定 FPS/RPG 模板 | `spec.ts:12-19,34-79` 以路径正则/用户 observation 选择类型；`templates.ts:144+` 固定引擎 | 引入 `revival-behavior/v1` 行为 IR；生成器消费动作、规则、地图和胜负条件，模板仅保留传输/认证/持久化基础组件 | VERIFIED |
| V007-002 | P1 | 内部模拟客户端被标成 `real-game-client` | `validator.ts` 报告构造；客户端由验证器创建，类型为 `types.ts:110` | 改为 `internal-protocol-client`；原客户端兼容使用独立证据与门禁 | VERIFIED |
| V007-003 | P1 | 无反模板验收，名称/路径变化也可能获得相同实现 | 现有测试只覆盖固定 FPS/RPG | 两个规则明显不同的保留样本；比较文件分析、行为规格、生成代码和联机结果 | VERIFIED |
| V007-004 | P1 | GitHub Actions 使用已弃用 Node20 运行时版本 | 全仓 `actions/checkout@v4`、`setup-node@v4`、`upload-artifact@v4`、`download-artifact@v4` | 升级官方 Node24 兼容版本并在 PR CI 验收 | VERIFIED |
| V007-005 | P2 | README Docker/L7 状态过期 | `README.md:29,69,195`；正式 CI 已通过 | 更新为 CI 已验证，并保留本机未运行说明 | FIXED |
| V007-006 | P2 | V006 能力矩阵 Docker/L7 状态过期 | `V006-CAPABILITY-MATRIX.md:17,21` | 对照正式 Run 回填，不篡改历史报告 | FIXED |
| V007-007 | P2 | 正式 v0.0.6 性能证据 Commit 不匹配 | 基准 JSON 指向 v0.0.5 快照；其 environment.commit `fa499e8a0e3d269489beb9b2c65cfe0b8e0cddf2` 经 GitHub API 核验不存在，历史来源不可核验，不能作为 v0.0.6 冻结 Commit 的性能证据 | 保留为 OPEN P2；重新在冻结 Commit 上运行并记录配置来源，未完成前不得用于发行声明 | OPEN |
| V007-008 | P1 | 负载测试修改认证限流，生产/测试配置边界不足清晰 | `benchmark-game-revival.mjs` 设置 `MAX_CONNECTIONS`，认证分批；未明确标注负载专用覆盖 | 显式 load-test profile，记录所有覆盖；生产默认安全门禁单独回归 | FIXED |
| V007-009 | P1 | 老软件、数据恢复、本地隐私、独立重建入口缺失 | 当前只有 `software` 静态文件分析 | 新建统一 Legacy Studio 核心任务与入口 | VERIFIED |
| V007-010 | P1 | 真实游戏原客户端兼容无验收样本 | CODOL 档案明确无客户端/授权；现有 FPS/RPG 为自研客户端 | 选择许可明确的开源多人游戏；原客户端连接独立服务；外部阻塞如实记录 | VERIFIED |
| V007-011 | P2 | 9 项跳过测试缺少机器可读的跨平台证据矩阵 | 现有 CI 有 Ubuntu/Windows 和真实工具作业，但无统一报告 | 建立 skip coverage 报告与门禁 | VERIFIED |
| V007-012 | P1 | 规格中的地图障碍物未进入生成服务逻辑 | `spec.ts:76` 默认障碍物；`templates.ts` 无 `obstacles` 引用 | 行为 IR 与地图碰撞/移动校验一致；无证据不得宣称恢复 | VERIFIED |
| V007-013 | P2 | 老软件外部依赖安装/许可证确认流程缺失 | 当前平台不管理 Wine/DOSBox/VM 安装 | 只生成建议与依赖清单；显式确认后才允许用户安装 | FIXED |
| V007-014 | P2 | 免费替代推荐尚无来源核验与许可证字段 | 当前无该模块 | 使用官方项目/许可证来源，禁止盗版与破解渠道 | VERIFIED |
| V007-015 | P1 | FPS 负载验证动作可能自指向并被拒绝 | `validator.ts` 负载动作目标选择；`templates.ts` 禁止自杀目标；默认 `loadClients=0` 未触发 | 负载动作选择其他玩家或明确非战斗移动；增加启用 loadClients 的回归 | VERIFIED |
| V007-016 | P1 | 无 planId 的直接任务可能绕过项目远程 AI 授权 | `workflow/src/agent.ts` 仅 planId 分支校验；`server.ts` 允许直接创建任务 | 在直接任务创建与 Worker 执行双层校验项目 remote_ai_allowed | VERIFIED |
| V007-017 | P0 | L0-L7 混合生成服务能力与目标复活证据，UNKNOWN 规格也可晋级 | `apps/web/src/pages/GameRevivalStudio.tsx:26-28`；`apps/api/src/game-revival.ts:65-73` 仅看 validation capabilities | 拆分 evidenceLevel 与 implementationLevel；未知行为规格不得宣称目标游戏复活 | VERIFIED |
| V007-018 | P1 | 游戏 ZIP 小文件导致 ArrayBuffer 内存放大 | `apps/api/src/game-archive.ts:79-130` 每文件预分配 16MiB+1 且 subarray 保留 backing store | 按实际大小分配并复制紧凑 Buffer；增加 2000 小文件内存回归 | VERIFIED |
| V007-019 | P1 | Windows 只有全新安装，没有旧版升级验收 | `release-v006.yml` clean install；能力矩阵却标 IMPLEMENTED | 增加 v0.0.6→新版本覆盖升级、数据保留与 smoke 门禁 | VERIFIED |
| V007-020 | P2 | 9 项 skip 缺少机器可读必跑项门禁 | CI 仅看退出码；Windows symlink 权限不足可静默 skip | JSON reporter + 指定安全用例不得跳过；环境限制单独记录 | VERIFIED |
| V007-021 | P2 | Game Revival 子进程继承完整宿主环境 | `validator.ts` npm/build/test 与生成服务继承 `process.env` | 最小环境 allowlist，过滤 Token/Key/云凭证；哨兵回归 | VERIFIED |
| V007-022 | P2 | 生成服务审计文件无上限且 `/audit` 全量读入内存 | `templates.ts:381-389` | URL 截断、限速、轮转、tail 读取与数据库大小上限 | VERIFIED |
| V007-023 | P1 | NSIS 默认覆盖安装可能触发 0xC0000005，历史修复要求保留 signAndEditExecutable | `apps/desktop/electron-builder.yml` 与 release-v006 clean install 未覆盖升级路径 | 恢复 win.signAndEditExecutable=false，新增旧版覆盖升级 + 数据保留 + smoke 门禁 | VERIFIED |
| V007-024 | P1 | 直接任务远程 AI 授权未绑定实际上传或路径，可跨目标外发 | `workflow/src/agent.ts` 将项目 target、路径和全部上传名并入候选集合 | 新增统一直接任务输入解析；只允许唯一 uploadId、绝对路径或项目 URL，歧义失败关闭；补旁路回归 | VERIFIED |
| V007-025 | P1 | XML 恢复正则回溯可阻塞 Worker | `legacy-revival/src/recovery.ts` 对未闭合标签使用同步回溯正则 | 改为有界线性扫描，限制嵌套深度、单元格与记录数，周期检查取消；60KB 未闭合样本回归 | VERIFIED |
| V007-026 | P1 | 生成数据转换器导出 CSV 公式单元格 | `legacy-revival/src/reconstruction.ts` 仅处理逗号和引号 | 对 `= + - @` 及前导空白/控制字符加文本前缀；生成工程真实转换回归 | VERIFIED |
| V007-027 | P1 | Legacy 分析达到上限后仍标 EVIDENCE | `legacy-revival/src/analyzer.ts` 截断字段存在但证据等级未降级 | 截断时降为 INFERENCE，根文件超限也标记 truncated；补目录上限回归 | VERIFIED |
| V007-028 | P1 | 行为验证覆盖不足仍可将 targetEvidence.behavior 标 VERIFIED | `validator.ts` 未逐项验证 minPlayers、攻击距离/冷却、heal、respawn 等 | 生成可执行 behavior-runtime 测试并纳入门禁；联机 harness 支持 minPlayers>2；未通过时降为 OBSERVED | VERIFIED |
| V007-029 | P2 | 校验和路径越界、扫描结束快照与增量预算不足 | `validator.ts` 直接拼接 SHA256SUMS 路径；`scanner.ts` 复用哈希不计预算且缺根目录结束快照 | 生成物路径包含性校验、行为摘要校验、根目录结束指纹复核、复用文件计入总字节预算 | VERIFIED |
| V007-030 | P2 | resume token 轮换、出生点与验证指标未完整断言 | `validator.ts` 未验证旧 token 失效；模板出生点相同；metrics 少算客户端 | 增加旧 token 拒绝断言、唯一出生点、真实客户端计数与报告一致性回归 | VERIFIED |
| V007-031 | P2 | Legacy Studio 项目切换竞态与隐私文案不准确 | 组件级任务状态未绑定项目；页面声称全部本地但共享引擎可能调用远程 AI | 任务绑定 projectId、切换清空表单、迟到响应不串项目；隐私文案明确远程 AI 需授权 | VERIFIED |
| V007-032 | P1 | 生成物校验清单允许未登记文件执行 | `validator.ts` 只核对清单内文件，未拒绝额外测试或脚本 | 校验前枚举实际文件集，要求与 SHA256SUMS 加清单自身完全一致 | VERIFIED |
| V007-033 | P1 | 行为解析与联机结算选择不同动作 | 解析按任意可达动作验收，harness 只取首个 attack/gather | 抽出共享 `selectWinningActions`，解析、联机与 Docker harness 使用同一选择 | VERIFIED |
| V007-034 | P1 | 行为运行时终局后冷却探针误判 | 动作结束对局后仍断言冷却，合法规格失败 | 冷却探针前重置对局状态但保留动作时间戳；采集探针同样重置终局 | VERIFIED |
| V007-035 | P1 | 无重生 firstToScore 人数口径不一致 | 解析按 maxPlayers 校验，harness 按 minPlayers 执行 | `requiredMatchSize` 统一按 target+1 计算并用于验证器与 Docker | VERIFIED |
| V007-036 | P1 | 多回合未重置积分、任务与背包 | 模板 start 只重置血量与位置 | 每回合重置 score/quest/inventory，并加运行时回归 | VERIFIED |
| V007-037 | P1 | SQLite WAL 边车未纳入恢复身份 | 只读打开主文件可能漏掉未检查点数据 | 默认拒绝非空 WAL，要求先 checkpoint；补回归 | VERIFIED |
| V007-038 | P1 | INTAKE 后源文件变化可污染后续阶段 | 直接路径与上传曾共用可变源：创建/首次 INTAKE 预检后仍可能重新读取源文件；Legacy 建快照前还缺 RE_LEGACY_ROOTS 复核 | 创建与首次 INTAKE 执行 adapter 输入预检，Legacy 建快照前复核 RE_LEGACY_ROOTS；直接路径复制、上传另存为任务私有不可变快照，恢复 INTAKE 时复用并复核摘要，后续阶段只读快照 | VERIFIED |
| V007-039 | P2 | 直接上传任务静默选择首个上传且未持久化 | `engine.create` 无 uploadId 时取首个上传 | 单上传自动绑定并持久化 uploadId；多上传失败关闭；补回归 | VERIFIED |
| V007-040 | P2 | 分析器跳过符号链接未标记截断 | 嵌套链接继续扫描但不体现完整性下降 | 链接或特殊文件命中时标记 truncated，档案降为 INFERENCE | VERIFIED |
| V007-041 | P2 | Windows 路径授权归一化不一致 | API 与 Worker 对大小写、盘符和相对段处理不同 | 共享 `normalizeInputTarget`，先识别绝对路径再规范化 URL | VERIFIED |
| V007-042 | P2 | CSV 公式中和破坏原始值回环 | 导出安全文本后 CSV→JSON 保留前缀单引号 | 在生成工具说明中明确安全导出语义，避免把中和值当原始数据 | FIXED |
| V007-043 | P2 | CLI 通用文本工具未消费功能需求 | requirements 只写入说明，生成器仍为固定复制工具 | 保留为明确基础组件；复杂需求必须选择专用生成器或后续扩展 | FIXED |
| V007-044 | P2 | 演示证据文件未纳入版本控制 | `artifacts/v007-game-compat` 仅存在工作树 | 将两份原客户端验收 JSON 纳入提交并由 CI/发行门禁复核 | VERIFIED |
| V007-045 | P2 | 缺陷登记缺少机器可读发布门禁 | P1 仍为 IN_PROGRESS 时无自动阻断 | 新增 `defects:check`，CI 与 v007 发行工作流强制无 OPEN/IN_PROGRESS P0/P1 | VERIFIED |
| V007-046 | P1 | 打包 Electron 的 Game Revival smoke 丢失 Node shim 标记 | `minimalProcessEnv` 未保留 `ELECTRON_RUN_AS_NODE`，生成服务以 Electron GUI 模式启动并提前退出 | 将 `ELECTRON_RUN_AS_NODE` 加入受限环境 allowlist，并新增回归断言 | VERIFIED |
| V007-047 | P1 | Windows Legacy smoke 直接调用 Electron GUI 子系统导致退出码与输出不可靠 | PowerShell 直接调用 Electron exe 后 `$LASTEXITCODE` 可为 null，且脚本错误输出无法稳定捕获 | 改用 CI Node 执行 smoke 脚本，仍从安装目录导入 Legacy 包，并强制校验退出码与输出 JSON | VERIFIED |

## 处理纪律

- 每项修复必须附失败/复现证据与修复后回归，不得删除失败测试、降低断言或改功能边界获取绿色。
- 文档偏差先修复为事实一致，不把 v0.0.6 历史文件伪造成当时已知道后续结果。
- 外部阻塞（缺少商业客户端、授权、物理设备、macOS 等）必须单列，不能计入通过能力。
- 本表随审计持续追加；最终交付需给出新增、修复、外部阻塞数量及 P0/P1 清单。
