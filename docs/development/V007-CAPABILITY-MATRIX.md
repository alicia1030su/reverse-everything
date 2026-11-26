# V007 能力矩阵

更新：2026-11-26。状态：VERIFIED / IMPLEMENTED / PARTIAL / BLOCKED / UNKNOWN / NOT_IMPLEMENTED / EXTERNAL_BLOCKED。

## v0.0.6 已核实基线

| 能力 | 状态 | 证据与边界 |
| --- | --- | --- |
| 固定 FPS/RPG 独立服务端生成 | VERIFIED | 真实 npm 构建、启动、内部客户端联机、Docker；不是目标游戏协议恢复 |
| 自有多人游戏 L7（部署证据） | VERIFIED | Release Run `45792899427` 的 candidate-game-docker；不能外推为商业游戏 L7 |
| L0-L7 生成服务验证 | PARTIAL | 等级混合实现能力与目标兼容证据，v0.0.7 需拆分 |
| 游戏目录只读增量扫描 | IMPLEMENTED | 白名单、元数据/指纹、资源上限；已有回归 |
| 游戏行为证据建模 | PARTIAL | observation 与文件路径线索，无通用行为 IR |
| 目标游戏行为驱动生成 | NOT_IMPLEMENTED | 固定模板；V007-001 |
| 原客户端协议兼容 | UNKNOWN | 无原客户端验收 |
| 多客户端同场 | VERIFIED | 内部协议客户端，不能称原客户端 |
| CODOL 2021 兼容 | EXTERNAL_BLOCKED | 无最终客户端、协议记录与授权 |
| 真实开源游戏原客户端兼容 | NOT_IMPLEMENTED | v0.0.7 目标 |
| Windows EXE 安装与重建 smoke | VERIFIED | v0.0.6 正式候选验收 |
| MCP 44 工具 | VERIFIED | `apps/cli/src/tools.ts` |
| Schema 5 | VERIFIED | contracts 与迁移 |
| Node24 Actions | NOT_IMPLEMENTED | 当前仍为 Node20 action 版本 |
| 全本地静态分析 | PARTIAL | 默认本地；外部工具与本机模型按需 |
| 老软件档案/兼容诊断 | NOT_IMPLEMENTED | v0.0.7 目标 |
| 软件授权诊断 | NOT_IMPLEMENTED | 仅合法诊断，不绕过 |
| 独立软件功能重建 | NOT_IMPLEMENTED | v0.0.7 目标 |
| 数据恢复/导出 | NOT_IMPLEMENTED | v0.0.7 目标 |
| Local Privacy Center | PARTIAL | 有安全默认值与远程 AI 确认，缺统一中心 |
| Free Alternative Finder | NOT_IMPLEMENTED | 必须真实来源与许可证 |
| macOS/代码签名 | EXTERNAL_BLOCKED | 无签名凭证与 macOS 验收环境 |

## v0.0.7 当前能力

| 能力 | 状态 | 证据与边界 |
| --- | --- | --- |
| 证据驱动游戏行为规格 | VERIFIED | `revival-behavior/v1`；duel/survival/last-standing/min-three 保留样本生成不同动作、生命值、重生、人数门槛、地图障碍物和胜负条件 |
| 反模板生成与联机 | VERIFIED | `game-revival.test.ts` 真实编译、启动并完成多人联机；生成工程 behavior-runtime 测试逐项断言人数、回合、移动、地图、攻击、采集、治疗、重生与胜负条件 |
| 生成服务实现等级与目标证据分离 | VERIFIED | L0-L7 仅表示实现/部署；行为、原客户端、原协议独立报告 |
| 真实开源游戏原客户端兼容 | VERIFIED | Pixelknight 与 Tron 原始浏览器客户端双人连接、操作、状态同步、重连；Pixelknight 另验证服务重启持久化，Tron 验证真实对局结束 |
| CODOL 2021 兼容 | EXTERNAL_BLOCKED | 无最终客户端、协议记录与授权；开源案例通过不能外推 |
| 统一 Legacy 任务引擎 | VERIFIED | 新增 `legacy` adapter，复用授权、Worker、资源与产物体系 |
| 老软件只读档案/兼容诊断 | VERIFIED | PE/ELF/Mach-O/MSI/JAR/Electron/Python/SQLite/CSV/DBF/INI/JSON/XML/目录；不执行未知样本 |
| 合法许可诊断 | VERIFIED | 状态为 EVIDENCE/INFERRED/UNKNOWN，不绕过许可或激活 |
| 独立软件功能重建 | VERIFIED | INI 编辑器独立工程真实测试和 HTTP 启动；CSV 查看器、数据转换器与文本工具具备生成器 |
| 数据恢复/导出 | VERIFIED | CSV、DBF、SQLite、INI 真实恢复回归；JSON/XML 有界读取；来源 SHA-256 前后一致 |
| Local Privacy Center | VERIFIED | 本地分析默认、远程 AI 显式授权、外部依赖仅建议；无远程 AI Key 实测声明 |
| 免费替代推荐 | VERIFIED | ImageGlass Classic、Audacious、7-Zip、PeaZip；官方地址、许可证、平台、差异与核验日期 |
| Web/API/CLI/MCP/Skill 同步 | VERIFIED | 版本 0.0.7、OpenAPI 0.0.7、Legacy 能力与隐私接口同步 |
| Schema 6 | VERIFIED | `game_profiles.behavior_json` 自动迁移与完整性检查 |
| Node24 Actions | VERIFIED | checkout v7、setup-node v7、upload-artifact v7、download-artifact v8 |
| 9 项历史跳过跨平台覆盖 | VERIFIED | Ubuntu 6、Windows 1、Android/Ghidra 2；7 项指定安全测试必须 passed |
| Windows v0.0.6 覆盖升级 | IMPLEMENTED | 门禁已实现，正式候选 Windows 作业验收后回填 VERIFIED |
| 发行资产 | IMPLEMENTED | 保留原 10 项，新增游戏兼容演示 ZIP、Legacy 演示 ZIP、demo-evidence.json，共 13 项；候选验收后回填 VERIFIED |
| macOS/代码签名 | EXTERNAL_BLOCKED | 无签名凭证与 macOS 验收环境 |
| 真实商业游戏客户端/物理设备 | EXTERNAL_BLOCKED | 无客户端、协议记录、授权或设备；不得计入通过能力 |

## 禁止声明

- 文件生成、内部客户端联机或 Docker 部署不等于原游戏客户端兼容。
- 模型输出不是 EVIDENCE/VERIFIED。
- 未运行的 macOS、商业游戏、物理设备、真实 AI Key 验收不得标为通过。
- 兼容性建议不是许可证恢复或授权绕过。
