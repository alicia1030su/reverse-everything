# V006 测试结果

更新：2026-11-26。仅记录实际执行结果。

## Phase 0 基线

- 源码快照：v0.0.5 发布 Commit `6cbd36cb995996c61d38156149396e0bb7a6c63c`；本地工作树与 codeload 快照逐文件比对一致（仅构建产物/数据目录差异）。
- `npm test`：55 files，605 passed / 9 skipped / 0 failed，退出码 0。
- `node scripts/benchmark.mjs --engine --samples 7 --warmup 2`：cold P95 456.68ms，hot P95 493.16ms，peak RSS 140.05MB。与历史数值不同，属于本机运行波动；未伪称复现历史数值。
- GitHub Latest：v0.0.5，draft=false，prerelease=false。

## 9 项跳过测试审计

| 测试 | 跳过原因 | 处置 |
| --- | --- | --- |
| deep-adapters (2) | Windows 不运行 POSIX JADX jar/symlink 用例 | Ubuntu CI 对应执行；Windows Ghidra 用例在本机执行 |
| api-safety (2) | Windows 跳过 POSIX 符号链接场景 | Ubuntu CI 执行；Windows 自有 junction/reparse point 回归 |
| windows-file-safety (1) | Windows 文件符号链接权限不足时显式 skip | 不伪装通过；Ubuntu 运行 POSIX 对应用例 |
| artifact-read-safety (1) | Windows 跳过 POSIX 符号链接用例 | Ubuntu CI 执行 |
| android-real (1) | 需 `RE_RUN_ANDROID_REAL=1` 与固定 JADX | Android/Ghidra 专用 CI 执行，普通测试不自动下载工具 |
| hardware-enumerate (1) | Linux sysfs 权限拒绝场景 | Windows 不伪装；Linux CI 执行 |
| upload-read-safety (1) | Windows 跳过 POSIX 符号链接用例 | Ubuntu CI 执行 |

未删除失败测试，未把跳过项计为通过。

## v0.0.6 已执行门禁

| 门禁 | 实际结果 |
| --- | --- |
| `npm run build` | 通过；19 个 workspace/应用完成构建 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | 64 files，724 passed / 9 skipped / 0 failed，退出码 0 |
| `npm run test:e2e` | 26/26 通过，含真实 Electron BrowserWindow 与 3 项 Game Revival Studio |
| `npm run docs:check` | 63 个 Markdown 文件、63 个本地链接通过 |
| `npm run version:check` | 0.0.6 在 19 个文件同步 |
| `npm run validate:skill` | 通过 |
| `npm run check:secrets` | 496 个文本文件通过 |
| `npm run licenses` | 122 个包，无禁止许可证 |
| `git diff --check` | 通过 |
| OpenAPI 契约 | 69 paths；真实路由与文档双向一致 |
| Windows EXE | NSIS 静默安装退出 0；`--smoke-test` 含真实 Game Revival 重建；版本 0.0.6；desktop-runtime 290 个生产包（含 npm@10.9.7） |
| 多人性能基准 | 2/8/16/32/64 客户端全部通过，2,440/2,440 动作成功 |
| 独立复审 | 初复审 P0=0/P1=22；二审剩余 10 项 P1；三审剩余 4 项 P1；修复后最终复审 P0=0/P1=0，全量 724 passed |

## 多人联机与安全验收

- 自有多人 FPS：4 客户端注册/登录、双房间隔离、服务端权威位置、动作/伤害/结算、resume 重连、重启恢复，真实 `npm ci/build/test` 后通过。
- 自有多人 RPG：4 客户端共享场景、背包、任务、隔离、结算、resume 重连、重启恢复，真实 `npm ci/build/test` 后通过。
- 生成服务安全：连接/认证/scrypt/token/房间资源上限、DNS rebinding 白名单、resume 防重放、持久化失败健康 503、关停 flush、非 root Docker 镜像。
- 扫描安全：RE_GAME_ROOTS 强制白名单、TOCTOU 校验、读取硬上限、实际字节计数、skipped≤100、增量证据降级。
- 归档安全：排除 node_modules/data/.env、条目/字节上限、ZIP 元数据直建、zip slip 与 canonical path 校验。

## v0.0.6 多人 FPS 性能基准

- 执行命令：`node scripts/benchmark-game-revival.mjs --clients 2,8,16,32,64 --output artifacts/v006-game-benchmark.json`
- 执行时间：2026-11-26；退出码 `0`，`passed=true`。
- 环境：Windows 11、Node `v22.22.2`、npm `10.9.7`、Intel Core Ultra 5 125H（18 逻辑核）、32,233.48MB 内存。
- 真实流程：生成临时 FPS 工程，`npm ci`、`npm run build`，每档独立 `npm start`；每档 20 轮，每客户端每轮各一次 `move` 与 `action`。
- 临时工程仅将 `AuthRateLimiter` 上限放大到 10,000，以支持同分钟注册超过 10 个账号；补丁前后 SHA-256 记录在 JSON 中。

| 客户端 | 注册认证 p50/p95 (ms) | 加入房间 p50/p95 (ms) | 移动 p50/p95 (ms) | 动作 p50/p95 (ms) | 总吞吐 (ops/s) | 游戏吞吐 (ops/s) | RSS 峰值 (MB) | CPU 均值/峰值 (%) | 失败数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 59.930 / 60.168 | 1.813 / 2.304 | 0.987 / 1.824 | 0.579 / 1.169 | 18.128 | 22.943 | 59.434 | 5.367 / 17.689 | 0 |
| 8 | 130.776 / 242.695 | 1.255 / 2.190 | 1.902 / 3.304 | 2.067 / 3.163 | 70.889 | 91.676 | 63.473 | 25.877 / 46.816 | 0 |
| 16 | 238.919 / 438.656 | 2.357 / 6.225 | 3.351 / 6.498 | 5.547 / 7.644 | 130.159 | 173.284 | 73.723 | 59.439 / 92.937 | 0 |
| 32 | 243.405 / 450.802 | 7.636 / 22.255 | 12.147 / 23.403 | 25.997 / 31.101 | 207.266 | 281.774 | 91.383 | 85.099 / 338.641 | 0 |
| 64 | 243.694 / 455.498 | 25.640 / 74.939 | 44.704 / 86.703 | 91.152 / 118.763 | 259.238 | 352.569 | 92.031 | 99.904 / 316.011 | 0 |

动作总计：2,440 次尝试 / 2,440 次成功。原始采样见 `artifacts/v006-game-benchmark.json`。

## 发行阻断项

- 本地无 Docker，未执行真实 Compose 部署，因此本地最高实测等级为 **L6**。
- CI `game-docker` 与 release candidate 必须真实生成并运行 FPS/RPG Docker 工程，严格校验 `cleanedUp`、健康状态、WS 同场、管理认证、checks、schema/hash；未通过不得创建正式 Tag 或发布。
- macOS/代码签名/真实物理设备仍未验证，不纳入 v0.0.6 成功声明。
