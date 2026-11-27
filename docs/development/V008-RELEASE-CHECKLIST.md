# v0.0.8 发行检查清单

目标版本：v0.0.8。正式发行 Run `45994026211`；冻结 / Build / Acceptance Commit 均为 `d2334ee267098e30f44b72c80f975e520abbc47c`。

## 冻结前

- [x] Phase 0 全量测试、E2E、独立审计完成，历史跳过逐项映射。
- [x] P0=0、P1=0；V008-003 与 V007-007 等 P2 有明确处置与对外口径。
- [x] 真实远程模型、Mock/规则型、本地模式证据分离；无 Key 不宣称真实验收。
- [x] Autopilot 规划、工具权限、预算、取消/恢复、Schema 7 迁移与安全回归通过。
- [x] `VERSION`、package manifests、README badge、能力声明、下载 tag 一致。
- [x] `npm run docs:check`、`version:check`、`defects:check`、`validate:skill`、secrets、licenses 通过。
- [x] build、typecheck、lint、全量测试、Web/Electron E2E、Docker、安装升级与 smoke 通过。
- [x] README 中英文、OpenAPI、CLI/MCP/Skill 文档与真实实现一致。

## 候选与原子发行

- [x] PR CI 全绿并合并 main，记录冻结 Commit。
- [x] 候选构建 Commit = 验收 Commit = annotated Tag 解引用 Commit。
- [x] 候选资产、SHA256SUMS、BUILD-INFO、RELEASE-MANIFEST、ACCEPTANCE、provenance 完整。
- [x] Windows 安装/覆盖升级/Portable 与 Server TGZ 从 neutral CWD 完成 smoke。
- [x] 创建唯一 annotated Tag `v0.0.8` 与 Draft Release，不覆盖历史 Tag/Release。
- [x] 全部约定资产上传，GitHub digest 与本地清单逐项一致。
- [x] Draft 一次性公开，`prerelease=false`，确认 Latest。
- [x] 从公开发行地址重新下载并执行 SHA-256 复验。
- [x] 记录 Release URL、Run ID、发布时间、资产数量与复验结果。

## 发行结果

| 项目 | 值 |
|---|---|
| Tag object | `79da5c63649ede8001457ae80dbe6c9b0a7335fc` |
| Tag 解引用 Commit | `d2334ee267098e30f44b72c80f975e520abbc47c` |
| Release ID | `460554844` |
| 发布时间 | 2026-11-27T12:11:55Z |
| 资产数量 | 15 |
| Draft / Prerelease | false / false |
| Latest | v0.0.8 |
| Release URL | https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.8 |

## 回退

候选或公开复验失败时保留上一正式版，不绕过门禁、不伪造签名或真实验收证据。修复后重新冻结并生成新候选；已公开资产不得静默覆盖。
