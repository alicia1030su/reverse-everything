# v0.0.4 测试结果

## Phase 0 基线

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | 2026-11-25 |
| `npm run lint` | 通过 | 2026-11-25 |
| `npm test` | 343 passed / 3 skipped；29/30 files 通过 | `platform.test.ts` 8 项全过后清理失败 |
| `npm test -- tests/integration/platform.test.ts` | 8 passed；suite 清理失败 | 同一宿主批量删除保护 |

失败不是产品断言：WorkBuddy safe-delete 在单个递归 rm 删除 85 项时要求批量确认。v0.0.4 将把测试清理改为已知临时根内的小批次，不绕过保护。

后续每轮记录：命令、退出码、通过/失败/跳过、代码哈希、CI Run ID、失败 exact 用例。
