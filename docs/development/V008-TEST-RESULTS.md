# v0.0.8 测试结果

> 日期：2026-11-27。状态：v0.0.8 已正式发布；候选 Run `45986134905`、原子发行 Run `45994026211` 与公开复验均通过。以下只记录实际运行证据。

## 最终分平台 Vitest

冻结 Commit：`d2334ee267098e30f44b72c80f975e520abbc47c`。

| 平台 | 总用例 | Passed | Failed | Skipped | Suites | 结果 |
|---|---:|---:|---:|---:|---:|---|
| Ubuntu | 913 | 906 | 0 | 7 | 73 | PASS |
| Windows | 913 | 905 | 0 | 8 | 73 | PASS |

跳过项仍为平台/真实工具条件：Windows reparse point 1 项；POSIX 符号链接/权限类 6 项；真实 JADX 1 项；非 Windows JADX 布局 1 项。跳过不等于通过，真实 JADX 由独立工作流覆盖。

## 完整 Playwright E2E

| 平台 | 总用例 | Passed | Failed |
|---|---:|---:|---:|
| Ubuntu | 32 | 32 | 0 |
| Windows | 32 | 32 | 0 |

覆盖 Autopilot 首页/动态问答/完成态交付中心、模型管理、旧专业工作台、真实 Electron BrowserWindow、Pixelknight/Tron 原客户端、网站采集、备份、硬件、向导、报告、Console、Game Studio、Legacy Studio。

Tron 用例曾在完整运行中暴露 `close()` 卡死；修复为先强制断开活跃 HTTP 连接再等待 Socket.IO 关闭。修复后单独 1/1、完整 E2E 32/32 均通过。

## 构建与静态门禁

| 检查 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS（0 errors） |
| `npm run docs:check` | PASS |
| `npm run defects:check` | PASS（无 OPEN/IN_PROGRESS P0/P1） |
| `npm run version:check` | PASS |
| `npm run validate:skill` | PASS |
| `npm run check:secrets` | PASS |
| `npm run licenses` | PASS |
| `npm audit --omit=dev` | PASS（0 vulnerabilities） |

## 候选与发行验收

| 检查 | 结果 |
|---|---|
| 候选 Run `45986134905` | PASS：Linux、Windows、FPS/RPG Docker、独立验收 |
| Linux 候选 | 全量测试、Autopilot core/API/Web E2E、MCP stdio/HTTP、原客户端、Server/CLI/Skill 干净 smoke、Docker 健康检查均通过 |
| Windows 候选 | EXE、Portable、v0.0.7→v0.0.8 覆盖升级、Schema 7、用户数据/项目保留、Game Revival、Legacy 独立启动均通过 |
| 正式发行 Run `45994026211` | PASS：freeze、候选、acceptance、Tag/Draft、upload verify、publish stable、public checksum |
| 资产数量 | 15 |
| Tag / Build / Acceptance Commit | 均为 `d2334ee267098e30f44b72c80f975e520abbc47c` |
| 公开复验 | 资产名称、大小、GitHub digest、SHA256SUMS 与公开重下载均通过 |
| 真实远程模型 | BLOCKED：V008-003，`MISSING_API_KEY`，`realModelCalled=false` |
| macOS | UNVERIFIED，未声明支持前不纳入通过口径 |

## 性能与演示资产

- Engine 基准：17 tasks，0 failed；冷/热 P95 169.79ms / 218.38ms；峰值 RSS 140.84MiB；全部阈值通过。见 `V008-PERFORMANCE.md`。
- E2E 基准：API/Worker 启动 2.336s；文件/网页/游戏任务 563ms / 5073ms / 2104ms；passed=true。
- 原客户端证据：Pixelknight/Tron 2/2 通过。
- `npm run package:demos`：最终 ZIP 干净解包、默认安装/测试/启动及原客户端冒烟通过；证据见 Release 资产 `demo-evidence.json`。

## 独立复审

独立只读复审结论：**P0=0、P1=0，可进入冻结**。候选与发行阶段追加发现并关闭 V008-020 至 V008-023：跨平台演示 ZIP 解包、Windows E2E 标题歧义、Windows 慢速 runner 等待、独立 Server 包缺少 Autopilot。全部修复均有回归与候选/CI 证据。

## 历史基线（不是本次结果）

v0.0.7 冻结 Commit `a54871a57e68aa0833a1636b79cf98e15bcd7cbe`：Ubuntu 784 passed / 7 skipped；Windows 783 passed / 8 skipped；E2E Ubuntu 28 passed / 1 skipped、Windows 29 passed；正式发行 Run `45912292229`。
