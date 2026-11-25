# v0.0.4 发行检查清单

- [x] 所有确认 P0/P1 修复并独立复审清零。
- [x] 旧 343 项及新增测试、真实 Electron/Web E2E 通过。
- [x] 大工件完整性、事件循环、SQLite 锁、取消、GC、崩溃恢复验收。
- [x] 缓存冷热归因及资源采样故障矩阵通过。
- [x] Windows Junction/Reparse/替换安全通过。
- [x] USB 只读枚举、官方离线样本、固件分析通过。
- [x] Ghidra/JADX 官方工具真实样本 CI 通过。
- [x] CLI/Server/Skill/MCP/API/Docker 全入口通过；最终 EXE/Portable 由候选工作流再次 smoke。
- [x] Server TGZ 与 Windows EXE/Portable 从 neutral CWD 验证 Ghidra Node launcher，不只检查文件存在。
- [x] README 中英文、真实截图、链接、命令、能力一致性通过。
- [x] build/typecheck/lint/secrets/licenses/audit/SBOM/OpenAPI 通过。
- [x] PR CI 全绿并正常合并 main，冻结 Commit `cfb19bbfa23d67ed23b660c793602bcadc1cffa6`。
- [x] 候选构建 Commit = 验收 Commit = 最终 Tag 解引用 Commit。
- [x] 候选安装、SHA256SUMS、BUILD-INFO、RELEASE-MANIFEST、ACCEPTANCE、provenance 通过。
- [x] 创建 annotated Tag `v0.0.4` 和 Draft Release。
- [x] 全部 12 个资产上传且 GitHub digest 与本地清单逐项一致。
- [x] Draft 一次性转为正式 Release，prerelease=false，GitHub Latest。
- [x] 从公开发行地址再次下载/校验并记录 Run ID/URL/时间。
- [x] 不覆盖历史 Tag/Release，不静默安装驱动，不伪造签名或物理设备验收。

## 最终证据

- Release：https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.4
- 候选 Run：`45611613592`
- 发行恢复 Run：`45622020772`（全绿）
- 发布时间：`2026-11-25T13:16:14Z`
- 资产数：12；公开地址复验 `sha256sum -c SHA256SUMS.txt` 全部通过。
