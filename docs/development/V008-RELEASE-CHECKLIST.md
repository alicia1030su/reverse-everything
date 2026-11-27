# v0.0.8 发行检查清单

目标版本：v0.0.8。当前 `VERSION` 已同步为 0.0.8；版本同步不等于已冻结或已发布，任何未完成项不得标记通过。

## 冻结前

- [ ] Phase 0 全量测试、E2E、独立审计完成，历史 9 项跳过逐项映射。
- [ ] P0=0、P1=0；V007-007 等 P2 有明确处置与对外口径。
- [ ] 真实远程模型、Mock/规则型、本地模式证据分离；无 Key 不宣称真实验收。
- [ ] Autopilot 规划、工具权限、预算、取消/恢复、Schema 7 迁移与安全回归通过。
- [ ] `VERSION`、package manifests、README badge、能力声明、下载 tag 一致。
- [ ] `npm run docs:check`、`version:check`、`defects:check`、`validate:skill`、secrets、licenses 通过。
- [ ] build、typecheck、lint、全量测试、Web/Electron E2E、Docker、安装升级与 smoke 通过。
- [ ] README 中英文、OpenAPI、CLI/MCP/Skill 文档与真实实现一致。

## 候选与原子发行

- [ ] PR CI 全绿并合并 main，记录冻结 Commit。
- [ ] 候选构建 Commit = 验收 Commit = annotated Tag 解引用 Commit。
- [ ] 候选资产、SHA256SUMS、BUILD-INFO、RELEASE-MANIFEST、ACCEPTANCE、provenance 完整。
- [ ] Windows 安装/覆盖升级/Portable 与 Server TGZ 从 neutral CWD 完成 smoke。
- [ ] 创建唯一 annotated Tag `v0.0.8` 与 Draft Release，不覆盖历史 Tag/Release。
- [ ] 全部约定资产上传，GitHub digest 与本地清单逐项一致。
- [ ] Draft 一次性公开，`prerelease=false`，确认 Latest。
- [ ] 从公开发行地址重新下载并执行 `sha256sum -c SHA256SUMS.txt`。
- [ ] 记录 Release URL、Run ID、发布时间、资产数量与复验结果。

## 回退

候选或公开复验失败时保留上一正式版，不绕过门禁、不伪造签名或真实验收证据。修复后重新冻结并生成新候选；已公开资产不得静默覆盖。
