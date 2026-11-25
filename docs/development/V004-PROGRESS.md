# v0.0.4 开发进度

最后更新：2026-11-25 UTC+8。

- 阶段：**已正式发布**。
- 发布分支：`main`；正式 Tag `v0.0.4` 指向冻结 Commit `cfb19bbfa23d67ed23b660c793602bcadc1cffa6`。
- 基线：v0.0.3 正式版本；v0.0.4 版本源 `VERSION=0.0.4`，Schema 3。
- 发布状态：https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.4

| Phase | 当前状态 | 证据 / 下一步 |
|---|---|---|
| 0 基线与能力审计 | 已完成 | BASELINE/CAPABILITY-MATRIX/DEFECT-REGISTER/PLAN |
| 1 大工件同步校验 | 已完成 | 两阶段发布、hash/事件循环/取消/GC 回归通过 |
| 2 缓存与资源采样 | 已完成 | 冷热归因、故障矩阵、桌面 sidecar 指标通过 |
| 3 工作流/文件/游戏安全 | 已完成 | Windows reparse/ACL、多实例、属性/长稳通过 |
| 4-11 硬件/固件 | 已完成 | 新包、adapter、官方离线样本、只读枚举；物理设备未授权 |
| 12 历史高级能力 | VERIFIED（限定范围） | Ghidra 12.2/JADX 1.5.3 官方工具已知答案 CI 通过 |
| 13 Web/桌面与全入口 | 已完成 | 硬件实验室、首次引导、CLI/MCP/Skill、九类入口；board 复用 hardware |
| 14 README | 已完成 | 中英文、能力/命令/链接一致性通过 |
| 15 全入口契约 | 已完成 | CLI/API/MCP 21 工具/OpenAPI v0.0.4/Skill |
| 16 资源优化 | 已完成 | 按需工具、分页、有界采集 |
| 17 全量测试与复审 | 已完成 | 冻结 CI 50 files / 525 passed / 7 skipped；发布后 main 本地 50 files / 528 passed / 8 skipped；独立复审 P0=0/P1=0 |
| 18 原子发行 | 已完成 | Draft→完整 digest→公开；恢复 Run `45622020772` 全绿 |
| 19 发行资产 | 已完成 | 12 个资产；公开地址复验 SHA256SUMS 全部通过 |
| 20 正式发布 | 已完成 | stable、非 prerelease、GitHub Latest |

## 当前已知限制

- 真实物理 USB 设备、实时捕获、驱动安装和用户凭证未获授权；只执行系统只读枚举。
- Ghidra/JADX 真实已知答案 CI 与工具 provenance 已通过；不扩展到未覆盖格式、架构或物理设备。
- 本地测试清理与宿主保护相关结果以 `V004-TEST-RESULTS.md` 为准。
- 网页兼容产物是静态预览；游戏 L4 是独立兼容服务；均不是原始服务端恢复。
- Windows 安装包未签名；不伪造代码签名。
- macOS、代码签名、物理设备和跨平台性能未验证项保持明确未验证声明。
