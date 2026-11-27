# v0.0.8 性能与资源报告

> 日期：2026-11-27。状态：冻结前本机基准通过；结果绑定当前工作树，不等同于候选资产或生产 SLA。

## 环境与方法

- Windows 11，Node.js v22.22.2，V8 12.4，Intel Core Ultra 5 125H，18 逻辑核心，32GiB 内存。
- Engine 基准：`node scripts/benchmark.mjs --engine --samples 7 --warmup 2 --output artifacts/v008-performance.json`。
- 端到端基准：`node scripts/benchmark.mjs --e2e artifacts/v008-e2e-performance.json`，真实 API + 独立 Worker + 文件/网页/游戏任务。
- Engine 内存采样间隔 5ms；E2E 资源值为轮询快照，不是高频真实峰值。所有任务串行执行。

## Engine 基准结果

| 指标 | 结果 |
|---|---:|
| 测量任务 | 17（2 冷预热 + 1 热预热 + 7 冷 + 7 热） |
| 失败任务 | 0 |
| 冷任务 P50 / P95 | 约 183ms / 169.79ms |
| 热任务 P50 / P95 | 约 189.85ms / 218.38ms |
| 冷 / 热吞吐 | 6.02 / 5.37 tasks/s |
| 冷 / 热缓存命中率 | 0% / 100% |
| 峰值 RSS | 140.84 MiB |
| 峰值 Heap Used | 54.33 MiB |
| GC Pause P95 | 0.0115ms |
| 每任务工件 P50 | 7 |
| 检测证据签名 | 冷热一致，1 个签名 |
| SQLite quick_check | ok |

Engine 基准全部阈值检查通过，报告见 `artifacts/v008-performance.json`。

## 端到端基准结果

| 指标 | 结果 |
|---|---:|
| API/Worker/Demo 启动 | 2.336s |
| 文件分析任务 | 563ms，9 evidence，7 artifacts |
| 网页采集任务 | 5.073s，29 evidence，28 artifacts |
| 游戏复活任务 | 2.104s，10 evidence，11 artifacts |
| API 空闲 RSS | 127 MiB |
| API 观察峰值快照 | 133 MiB |
| Worker 观察峰值快照 | 133 MiB |
| 结果 | passed=true |

端到端报告见 `artifacts/v008-e2e-performance.json`。网页任务包含真实浏览器采集，耗时高于纯文件分析属预期。

## 默认预算

- 任务默认超时：300,000 ms；上限 3,600,000 ms。
- 默认磁盘：1,024 MiB；上限 20,480 MiB。
- 默认内存：2,048 MiB；上限 16,384 MiB。
- 默认模型调用/Token/费用：0；规则型执行不调用模型。
- 默认修复尝试：2；上限 10。
- 静态站点工具：单步 30s / 64 MiB。
- allowlist 命令：单步 300s / 1,024 MiB。
- Provider 默认：60s 超时、1 次重试、60 请求/分钟、单次 4096 Token、单任务 100,000 Token、5 USD。

预算字段存在不等于所有资源限制都已由操作系统强制实施。

## 结论与限制

- 冻结前本机 Engine 与 E2E 基准均通过，可作为当前工作树的性能证据。
- 未覆盖 macOS、Linux、多 Worker 并发、1000 任务长稳、真实远程模型延迟/费用、物理设备与所有商业客户端。
- 工件打包会复制文件并多次读取计算哈希，大文件仍可能产生显著 I/O。
- Provider 用量预算主要保存在进程内 Map，重启后不保证完整累计。
- V007-007 历史性能 JSON 来源不可核验，继续作为 OPEN P2，不作为本报告证据。
