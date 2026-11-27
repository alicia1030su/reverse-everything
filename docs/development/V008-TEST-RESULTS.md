# v0.0.8 测试结果

> 日期：2026-11-27。状态：冻结前本机门禁通过；PR CI、分平台候选与公开复验待执行。以下只记录实际运行证据。

## 全量 Vitest

命令：

```bash
npx vitest run --reporter=json --outputFile=artifacts/v008-vitest.json
```

环境：Windows 11，Node.js v22.22.2，Vitest 3.2.4，当前工作树。

| 指标 | 结果 |
|---|---:|
| Test suites | 182 passed / 0 failed |
| Tests | 910 total |
| Passed | 901 |
| Failed | 0 |
| Skipped | 9 |
| Todo | 0 |
| 退出码 | 0 |

9 项跳过与历史平台/真实工具条件一致：Windows reparse point 1 项；POSIX 符号链接/权限类 6 项；真实 JADX 1 项；非 Windows JADX 布局 1 项。跳过不等于通过，CI 必须在对应平台/工具作业中覆盖。

## 完整 Playwright E2E

命令：`npm run test:e2e`

| 指标 | 结果 |
|---|---:|
| 总用例 | 32 |
| 通过 | 32 |
| 失败 | 0 |
| 耗时 | 约 1.9 分钟 |

覆盖 Autopilot 首页/动态问答/完成态交付中心、模型管理、旧专业工作台、真实 Electron BrowserWindow、Pixelknight/Tron 原客户端、网站采集、备份、硬件、向导、报告、Console、Game Studio、Legacy Studio。

Tron 用例曾在完整运行中暴露 `close()` 卡死；修复为先强制断开活跃 HTTP 连接再等待 Socket.IO 关闭。修复后单独 1/1、完整 E2E 32/32 均通过。

## 构建与静态门禁

| 检查 | 结果 |
|---|---|
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS（0 errors；本地含未提交审计目录 warning） |
| `npm run docs:check` | PASS（114 links / 95 Markdown） |
| `npm run defects:check` | PASS（64 entries，无 OPEN/IN_PROGRESS P0/P1） |
| `npm run version:check` | PASS（22 files） |
| `npm run validate:skill` | PASS |
| `npm run check:secrets` | PASS（1156 text files） |
| `npm run licenses` | PASS（122 packages，无 disallowed） |
| `npm audit --omit=dev` | PASS（0 vulnerabilities） |

## 性能与演示资产

- Engine 基准：17 tasks，0 failed；冷/热 P95 169.79ms / 218.38ms；峰值 RSS 140.84MiB；全部阈值通过。见 `V008-PERFORMANCE.md`。
- E2E 基准：API/Worker 启动 2.336s；文件/网页/游戏任务 563ms / 5073ms / 2104ms；passed=true。
- 原客户端证据：Pixelknight/Tron 2/2 通过。
- `npm run package:demos`：最终 ZIP 干净解包、默认安装/测试/启动及原客户端冒烟通过；证据见 `dist/release/demo-evidence.json`。

## 独立复审

独立只读复审结论已完整收到：**P0=0、P1=0，可进入冻结**。剩余 P2 为 V008-003（真实远程 Key 阻塞）、V007-007（历史性能来源不可核验）、V008-016（成本单位已修复登记）。复审成员最后回传网络超时，但结论内容完整，未将传输失败作为额外证据。

## 待完成

| 检查 | 状态 |
|---|---|
| PR CI（Ubuntu/Windows/Docker/真实工具） | UNVERIFIED |
| 候选 Windows 安装/升级/Portable smoke | UNVERIFIED |
| 候选资产 SHA256/provenance/acceptance | UNVERIFIED |
| 真实远程模型 E2E | BLOCKED：V008-003，无 Key |
| macOS | UNVERIFIED，未声明支持前不纳入通过口径 |
| 公开下载复验与 Latest | UNVERIFIED |

## 历史基线（不是本次结果）

v0.0.7 冻结 Commit `a54871a57e68aa0833a1636b79cf98e15bcd7cbe`：Ubuntu 784 passed / 7 skipped；Windows 783 passed / 8 skipped；E2E Ubuntu 28 passed / 1 skipped、Windows 29 passed；正式发行 Run `45912292229`。
