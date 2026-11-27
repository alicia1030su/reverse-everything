# v0.0.7 冻结测试结果

更新：2026-11-27。本报告记录 v0.0.7 正式发行 Commit 的分平台证据，不用开发期本机数字替代冻结结果。

## 冻结身份

| 项目 | 值 |
|---|---|
| 产品版本 | `0.0.7` |
| Annotated Tag | `v0.0.7` |
| Tag object | `6e2316a1b4ad327ae1a096b2efa5410b5ec5618d` |
| Tag 解引用 Commit | `a54871a57e68aa0833a1636b79cf98e15bcd7cbe` |
| 主 CI Run | `45910219157` |
| 正式发行 Run | `45912292229` |
| 正式发布时间 | `2026-11-26T23:56:38Z` |
| 公开资产 | 15 项（13 项 manifest 资产 + RELEASE-MANIFEST.json + SHA256SUMS.txt） |

## 主 CI 分平台结果

以下数字来自 Run `45910219157` 在冻结 Commit 留存的 Vitest JSON 制品，而非当前开发工作树复跑。

| 平台 | 文件数 | 测试总数 | passed | skipped | failed | 结果 |
|---|---:|---:|---:|---:|---:|---|
| Ubuntu | 67 | 791 | 784 | 7 | 0 | success |
| Windows | 67 | 791 | 783 | 8 | 0 | success |

证据制品：

- `vitest-ubuntu-latest.json`：784 passed / 7 skipped。
- `vitest-windows-latest.json`：783 passed / 8 skipped。

## E2E 分平台结果

| 平台 | passed | skipped | 说明 |
|---|---:|---:|---|
| Ubuntu | 28 | 1 | Electron 桌面用例按平台条件跳过 |
| Windows | 29 | 0 | 包含 Electron 桌面用例 |

因此 v0.0.7 的 E2E 口径是 **Ubuntu 28 passed / 1 skipped，Windows 29 passed**，不能写成跨平台 29/29。默认 Playwright 配置共列出 29 项，独立桌面配置会重复列出同一桌面用例，不额外计入总数。

## 历史数字口径

`V007-PLAN.md` 与早期报告中的“782 passed / 9 skipped；E2E 29/29”是开发期本机记录，未留存可对应冻结 Commit 的 Vitest JSON。冻结结论以上述 CI 制品为准；历史数字保留用于追踪，不标为冻结 Commit 的全平台结果。

## 跳过映射与发行门禁

- 9 项历史跳过按平台条件和真实工具条件分类，详见 `V008-KNOWN-ISSUES.md`。
- `check-skip-coverage.mjs` 对 7 项指定安全用例要求对应平台 passed，不允许静默 skip。
- Android JADX、Ghidra 等真实工具工作流独立验收，Mock 不替代真实工具。
- 正式 Release Run `45912292229` 的 freeze、candidate-linux、candidate-windows、candidate-game-docker、candidate-acceptance、tag-draft、upload-verify、publish-stable 共 8 个 job 全部 success。
- Windows 升级证据记录 `previousVersion=0.0.6`、`version=0.0.7`、`schemaVersion=6`、用户数据与项目保留，并完成 Game Revival 与 Legacy smoke。

## 未覆盖与不可外推

- macOS、代码签名凭证、未授权商业游戏客户端与物理设备未验收。
- 真实远程模型 Key 验收与 Mock/规则型结果必须分开记录。
- Ubuntu 的桌面用例跳过不能写成桌面端已在 Ubuntu 通过。
- V007-007 性能 JSON 来源不可核验，不作为本版本性能结论。
