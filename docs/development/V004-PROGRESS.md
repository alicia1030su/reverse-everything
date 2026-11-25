# v0.0.4 开发进度

最后更新：2026-11-25 UTC+8。

- 阶段：本地候选门禁通过，CI 真实工具验收与正式发行未完成。
- 分支：`feat/v0.0.4-hardware-lab`。
- 基线：v0.0.3 正式版本；当前版本源 `VERSION=0.0.4`，Schema 3。
- 发布状态：尚未创建 v0.0.4 Tag 或正式 Release；不得将候选构建描述为已发布。

| Phase | 当前状态 | 证据 / 下一步 |
|---|---|---|
| 0 基线与能力审计 | 已完成 | BASELINE/CAPABILITY-MATRIX/DEFECT-REGISTER/PLAN |
| 1 大工件同步校验 | 实现已落地，待最终门禁 | 两阶段发布、hash/事件循环/取消/GC 回归以最终测试为准 |
| 2 缓存与资源采样 | 实现已落地，待最终门禁 | 冷热归因、故障矩阵、桌面 sidecar 指标 |
| 3 工作流/文件/游戏安全 | 实现已落地，待最终门禁 | Windows reparse/ACL、多实例、属性/长稳 |
| 4-11 硬件/固件 | 实现已落地，待最终门禁 | 新包、adapter、官方离线样本、只读枚举；物理设备未授权 |
| 12 历史高级能力 | PARTIAL / BLOCKED | Ghidra/JADX 代码已实现；真实工具 CI 完成前不得标 VERIFIED |
| 13 Web/桌面与全入口 | 实现已落地，待最终门禁 | 硬件实验室、首次引导、CLI/MCP/Skill、九类入口；board 复用 hardware |
| 14 README | 文档已更新，文档校验通过 | 中英文、能力/命令/链接一致性；docs:check、Skill、version 与 diff 检查通过 |
| 15 全入口契约 | 实现已落地，待最终门禁 | CLI/API/MCP 21 工具/OpenAPI v0.0.4/Skill |
| 16 资源优化 | 实现已落地，待最终门禁 | 按需工具、分页、有界采集 |
| 17 全量测试与复审 | 本地通过，CI 待完成 | 49 files / 513 passed / 7 skipped；Web 7/7、Electron 1/1；独立复审 P0=0/P1=0 |
| 18 原子发行 | 待最终门禁 | Draft→完整 digest→公开；不得提前创建正式 Tag |
| 19 发行资产 | 待冻结 Commit | 从冻结 Commit 构建并核对哈希 |
| 20 正式发布 | BLOCKED | 全部门禁完成后才可创建 stable Release |

## 当前已知限制

- 真实物理 USB 设备、实时捕获、驱动安装和用户凭证未获授权；只执行系统只读枚举。
- Ghidra/JADX 真实已知答案 CI 与工具 provenance 已通过；最终打包环境证据由候选工作流复验。
- 本地测试清理与宿主保护相关结果以最终 `V004-TEST-RESULTS.md` 为准，不以历史数字宣称套件全绿。
- 网页兼容产物是静态预览；游戏 L4 是独立兼容服务；均不是原始服务端恢复。
- Windows 安装包未签名；不伪造代码签名。
- 所有未定稿测试、性能、CI 与发行数据均以最终门禁为准。
