# v0.0.8 已知问题与历史跳过映射

更新：2026-11-27。本文件区分平台条件跳过、真实工具条件跳过与未关闭缺陷；跳过不等于通过。

## 历史 9 项跳过测试

来源：v0.0.7 开发期本机历史声明 782 passed / 9 skipped，以及 `scripts/check-skip-coverage.mjs` 的机器可读映射。该数字不是正式分平台发行口径；冻结 Commit 的正式结果见 [V007 测试结果](V007-TEST-RESULTS.md)（Ubuntu 784 passed / 7 skipped，Windows 783 passed / 8 skipped）。

| # | 测试 | 源条件 | 分类 | 覆盖方式 |
|---|---|---|---|---|
| 1 | `deep-adapters.test.ts`：accepts the all-in-one CLI jar layout from an external JADX home | `runIf(process.platform !== 'win32')` | 平台 / 真实工具 | 非 Windows 常规作业；Android 真实 JADX 工作流提供固定版本工具证据 |
| 2 | `deep-adapters.test.ts`：rejects symbolic links in JADX output without following them | `runIf(process.platform !== 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |
| 3 | `android-real.test.ts`：runs pinned real JADX and compares Java, method, string, manifest and resource outputs | `RE_RUN_ANDROID_REAL !== '1'` | 真实工具条件 | `android-v004.yml` 设置 `RE_RUN_ANDROID_REAL=1` 并校验固定 JADX |
| 4 | `windows-file-safety.test.ts`：rejects a final-component symbolic-link reparse point | `skipIf(process.platform !== 'win32')` | 平台条件 | Windows 必过安全用例，Ubuntu 不运行 |
| 5 | `artifact-read-safety.test.ts`：rejects symbolic links without reading their target | `skipIf(process.platform === 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |
| 6 | `hardware-enumerate.test.ts`：classifies sysfs permission denial as BLOCKED | `skipIf(process.platform === 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |
| 7 | `upload-read-safety.test.ts`：rejects a symbolic-link upload instead of following it | `skipIf(process.platform === 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |
| 8 | `api-safety.test.ts`：refuses project deletion through a linked parent component | `skipIf(process.platform === 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |
| 9 | `api-safety.test.ts`：never serves an artifact path that was replaced with a symbolic link | `skipIf(process.platform === 'win32')` | 平台条件 | Ubuntu 必过安全用例，Windows 不运行 |

分类汇总：7 项由操作系统/符号链接能力条件触发，2 项由真实 JADX 工具或显式 opt-in 条件触发。Windows reparse-point 用例若因权限不足调用 `skip()`，CI 的必过断言会失败，不得静默放行。

## 未关闭缺陷

| ID | 级别 | 状态 | 说明 |
|---|---|---|---|
| V007-007 | P2 | OPEN | 历史性能 JSON 指向 v0.0.5 快照；其 environment.commit `fa499e8a0e3d269489beb9b2c65cfe0b8e0cddf2` 经 GitHub API 核验不存在，来源不可核验；冻结重跑前不得作为发行性能证据 |
| V008-003 | P2 | OPEN | 真实远程 AI Key 端到端验收受外部凭证阻塞；无可用 Key 时保持 BLOCKED，不以 Mock 替代 |

其余 Phase 0 审计缺陷统一登记在 `V008-DEFECT-REGISTER.md`。P0/P1 未清零不得发布 v0.0.8。
