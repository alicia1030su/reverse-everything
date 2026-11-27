# v0.0.8 执行进度

更新：2026-11-27。`VERSION` 已同步为 `0.0.8`；冻结前本机门禁通过，待提交、PR CI、候选资产与正式发行。

## 阶段状态

| 阶段 | 状态 | 证据 / 下一步 |
|---|---|---|
| Phase 0 基线与独立审计 | COMPLETED | v0.0.7 发行源核实；四组只读审计与 V008 文档体系完成 |
| Phase 1-11 Autopilot 核心与契约 | COMPLETED | Schema 7、动态规划、持久化编排、Provider V4、Tool Registry、证据与交付 |
| Phase 12-20 成品、修复闭环与独立验收 | COMPLETED | Build-Test-Repair、独立验收、交付中心、暂停/恢复/取消与租约续期 |
| Phase 21-24 产品化与安全审计 | COMPLETED | Web/Desktop/API/CLI/MCP/Skill 全入口；独立复审 P0=0/P1=0 |
| Phase 25-28 黑盒验收、指标、README、全量回归 | COMPLETED | 901 passed / 9 skipped；E2E 32/32；性能基准通过 |
| Phase 29-30 候选资产验收、原子正式发行 | IN_PROGRESS | 待提交、PR CI、候选 smoke、Tag/Release 与公开复验 |

## 冻结前本机门禁

- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm run lint`（0 errors）
- [x] 全量 Vitest：901 passed / 9 skipped / 0 failed
- [x] 完整 Playwright E2E：32/32
- [x] `npm run docs:check`
- [x] `npm run defects:check`（无 OPEN/IN_PROGRESS P0/P1）
- [x] `npm run version:check`
- [x] `npm run validate:skill`
- [x] `npm run check:secrets`
- [x] `npm run licenses`
- [x] `npm audit --omit=dev`（0 vulnerabilities）
- [x] Engine 与 E2E 性能基准
- [x] Pixelknight/Tron 原客户端与最终演示 ZIP 干净解包验收
- [x] 独立冻结复审：P0=0、P1=0

## 待完成

- [ ] 提交并推送 `feat/v0.0.8-autopilot`
- [ ] 创建 PR 并等待 CI 全绿
- [ ] 正常合并 main
- [ ] 运行 v0.0.8 候选发行工作流
- [ ] Windows 安装/升级/Portable、Linux/Docker、MCP、原客户端 smoke
- [ ] 候选资产 SHA256、provenance、ACCEPTANCE 验收
- [ ] annotated Tag、唯一 Draft、按 Release ID 上传并一次性公开
- [ ] 公开下载复验与 Latest 确认
- [ ] 回填正式 Release URL、Run ID、资产数量与最终报告

## 证据纪律

未经实际运行的检查标为 UNVERIFIED；历史 v0.0.7 结果仅作为基线，不冒充当前工作树结果。真实远程模型、物理设备与外部客户端证据独立记录，Mock 或规则型结果不得替代。V008-003 无 Key 时保持 BLOCKED；V007-007 历史性能 JSON 来源不可核验，继续作为 OPEN P2。
