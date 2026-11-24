# v0.0.3 性能与长稳验收

测量日期：2026-11-24（UTC+8）

## 环境与方法

- 平台：Windows x64，Node.js 22，单并发。
- 引擎基准：`node scripts/benchmark.mjs --engine --output docs/development/PERFORMANCE-v003.json`。
- 工作负载：真实 `WorkflowEngine` + 内存 SQLite + 内置 file adapter；冷缓存每任务使用新项目命名空间，热缓存复用同一项目与输入。
- 样本：每阶段 7 个测量任务，2 个冷缓存预热任务，1 个热缓存预热任务。
- 内存：任务期间每 5ms 采样 Node RSS/Heap；不强制 GC。
- 长稳：`node scripts/soak.mjs --confirm SOAK`，100 个真实任务，每 10 个任务采样。
- 阈值固定在脚本中，可由环境变量显式覆盖；本次未为通过而放宽阈值。

## 引擎基准结果

| 指标 | 冷缓存 | 热缓存 | 阈值 |
|---|---:|---:|---:|
| 任务 p50 | 62.38ms | 62.45ms | — |
| 任务 p95 | 66.85ms | 68.25ms | ≤2500ms |
| 吞吐 | 14.74 tasks/s | 15.58 tasks/s | ≥0.2 tasks/s |
| 缓存命中率 | 0% | 100% | 冷≤5%，热≥95% |
| 每任务产物 p50 | 7 | 7 | ≥1 |

- 峰值 RSS：144.93MB（阈值 768MB）。
- 峰值 Heap Used：50.17MB（阈值 512MB）。
- GC pause p95：0.0062ms（阈值 500ms）。
- 所有阶段 p95 均低于 1500ms；失败任务 0；SQLite `quick_check=ok`。
- 结果：`passed=true`，完整 JSON 见 `docs/development/PERFORMANCE-v003.json`。

## 100 任务长稳结果

| 指标 | 实测 | 阈值 |
|---|---:|---:|
| 完成/失败 | 100 / 0 | 100 / 0 |
| 总时长 | 9.522s | — |
| 吞吐 | 10.50 tasks/s | — |
| 任务 p50 / p95 | 71.94ms / 98.27ms | — |
| 峰值 RSS | 154.79MB | — |
| 后半段 RSS 平均增长 | 1.79MB | ≤128MB |
| RSS 斜率 | 40.47MB / 100 tasks | ≤64MB / 100 tasks |
| 缓存 hits/misses/writes | 297 / 3 / 300 | 热缓存 99% |
| 缓存损坏/淘汰 | 0 / 0 | 0 |
| SQLite quick_check | ok | ok |
| 任务状态不一致 | 0 | 0 |

- 内存趋势门禁最少 40 个任务；10–20 任务短测只验证任务、缓存与数据库正确性，不宣称完成泄漏验证。
- 结果：`passed=true`，完整 JSON 见 `data/v003-soak.json`。

## 边界

- 上述数字来自本机单并发测量，不代表所有硬件或 Chromium/Ghidra 外部工具场景。
- Node RSS 基准不包含独立 API/Worker/桌面进程；进程树与 Chromium 场景由资源监控和 E2E 基准单独测量。
- 性能阈值是回归门禁，不是服务等级承诺。
