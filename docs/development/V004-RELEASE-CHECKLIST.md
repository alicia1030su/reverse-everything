# v0.0.4 发行检查清单

- [ ] 所有确认 P0/P1 修复并独立复审清零。
- [ ] 旧 343 项及新增测试、真实 Electron/Web E2E 通过。
- [ ] 大工件完整性、事件循环、SQLite 锁、取消、GC、崩溃恢复验收。
- [ ] 缓存冷热归因及资源采样故障矩阵通过。
- [ ] Windows Junction/Reparse/替换安全通过。
- [ ] USB 只读枚举、官方离线样本、固件分析通过。
- [ ] Ghidra/JADX 官方工具真实样本 CI 通过。
- [ ] CLI/Server/Skill/MCP/API/Docker/EXE/Portable 全入口通过。
- [ ] README 中英文、真实截图、链接、命令、能力一致性通过。
- [ ] build/typecheck/lint/secrets/licenses/audit/SBOM/OpenAPI 通过。
- [ ] PR CI 全绿并正常合并 main，冻结 Commit。
- [ ] 候选构建 Commit = 验收 Commit = 最终 Tag 解引用 Commit。
- [ ] 候选安装、SHA256SUMS、BUILD-INFO、RELEASE-MANIFEST、ACCEPTANCE、provenance 通过。
- [ ] 创建 annotated Tag 和 Draft Release。
- [ ] 全部资产上传且 GitHub digest 与本地清单逐项一致。
- [ ] Draft 一次性转为正式 Release，prerelease=false，GitHub Latest。
- [ ] 从公开发行地址再次下载/校验并记录 Run ID/URL/时间。
- [ ] 不覆盖历史 Tag/Release，不静默安装驱动，不伪造签名或物理设备验收。
