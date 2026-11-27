# v0.0.8 全量基线审计

审计日期：2026-11-27。审计原则：只读核实真实仓库，不采信历史完成报告。

## 正式发行源

| 项目 | 核实结果 |
|---|---|
| 仓库 | `alicia1030su/reverse-everything` |
| 最新正式版 | `v0.0.7`，`draft=false`，`prerelease=false` |
| Annotated Tag object | `6e2316a1b4ad327ae1a096b2efa5410b5ec5618d` |
| Tag 解引用 Commit | `a54871a57e68aa0833a1636b79cf98e15bcd7cbe` |
| Commit 标题 | `docs: record verified v0.0.7 candidate evidence` |
| 正式发行 Run | `45912292229` |
| Release 资产 | 15 个 |
| Schema | 6（v0.0.7） |
| 历史声明 | 782 passed / 9 skipped；Web/Electron E2E 29/29 |

来源：GitHub Releases API、Git Data API、正式 Commit 的官方 tarball。当前工作树从该 tarball 恢复；本地旧 Git 对象不作为基线依据。

## 审计维度

1. 自然语言理解与 AI V3 自主执行真实性。
2. 固定计划/模板与动态规划的边界。
3. 游戏行为 IR 与原客户端兼容独立性。
4. Legacy 独立可运行产物。
5. 模型与工具调用契约、真实远程 Key 验收。
6. 历史跳过测试与 V007-007 性能证据。
7. Windows Electron Node shim、安装升级与退出码。
8. README、版本与发行资产一致性。
9. 未关闭 Issue/PR、TODO/FIXME。
10. 历史 P0/P1 安全与稳定性回归。

## 初始事实

- `packages/ai/src/index.ts` 仅提供 Token 估算、截断和脱敏，不是模型客户端。
- 模型请求位于 `packages/workflow/src/agent.ts`，为单轮 `/chat/completions` 文本调用；未声明 Tool Calling。
- `packages/planner/src/types.ts` 的 `AnalysisPlan.deterministic` 固定为 `true`，现有规划器是确定性计划，不是自主重规划。
- 现有工作流有租约、 fencing、快照、预算、事件与恢复基础，可作为 Autopilot 的持久化底座。
- v0.0.8 将新增 Schema 7 的 Autopilot 表，不重写稳定分析器。

## 复现结果

待 Phase 0 全量测试与独立审计回填。任何未经实际运行的结论标记为 UNVERIFIED。
