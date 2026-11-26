# v0.0.5 测试结果

最后更新：2026-11-26。本文件记录实际命令、退出码、通过/失败/跳过、Commit 与 CI Run ID；未运行的检查不标为通过。

## Phase 0 基线

| 命令 / 检查 | 结果 | 备注 |
|---|---|---|
| `npm test -- --reporter=json` | 50 files；528 passed / 8 skipped / 0 failed | main `b259042` |
| `node scripts/benchmark.mjs --engine --samples 7 --warmup 2` | 全部门禁通过 | cold P95 271.29ms，hot P95 181.04ms，hot hit=1.0，writes=0，peak RSS 144.21MB |
| GitHub Release API | v0.0.4 public/latest；12 资产一致 | Tag=Build=Acceptance Commit |

## Wave 1 发行脚本

| 检查 | 结果 | 备注 |
|---|---|---|
| release-atomic | 12/12 | 分页、Release ID、429/503、重复资产、公开下载校验、损坏/原子状态、双端点 404 |
| release-provenance | 7/7 | 候选、迁移、篡改与 Tag 解引用 |
| release-workflows | 7/7 | 发行工作流身份门禁 |

## Wave 2 解析器与外部工具

| 检查 | 结果 | 备注 |
|---|---|---|
| HAR 100MB-class / 64MiB 堆 | 通过 | 流式 `log.entries`，单条目有界 |
| HAR 100MB-class / 128MiB 堆 | 通过 | 同上 |
| usbmon 100MB-class / 64MiB 堆 | 通过 | 流式逐行，行宽/记录数有界 |
| usbmon 100MB-class / 128MiB 堆 | 通过 | 同上 |
| deep-adapters | 52 passed / 2 skipped | JADX/Ghidra 故障矩阵、APK/PCAP/PCAPNG |
| typecheck / lint | 通过 | 无错误、无警告 |

## Wave 3-4 主机研究与智能计划

| 检查 | 结果 | 备注 |
|---|---|---|
| console | 14/14 | 设备目录、C0-C5、档案、USB 诊断、报告、证据信任边界 |
| planner | 32/32 | 检测、选择、计划、预算、自适应 |
| research API | 7/7 | 档案、授权计划执行、上传/URL 绑定、撤销/过期、畸形输入、演示与双视图报告 |
| AI V3 | 5/5 | 角色路由、安全提示词、远程拒绝与本地模型放行 |
| workflow / agent 回归 | 80/80 | 旧角色与 V3 开关兼容 |
| Schema 4 迁移/备份 | 24/24 | v0.0.1/v0.0.2 升级、已有 Schema 4 增列、删除意图、备份恢复 |
| macOS 进程采样 | 5/5 | 时间分量严格 `0..59` |
| 全量 build | 通过 | contracts/evidence/security/ai/workflow/hardware/firmware/console/planner/core/api/worker/cli/desktop/web |

## 当前全量回归状态

2026-11-26 全量 `npm test`：**55 files，605 passed / 9 skipped / 0 failed**。退出码 0。

新增跳过项为 POSIX 父级 symlink 删除负向用例在 Windows 的平台跳过；Linux CI 执行。其余跳过原因见下表。

## Web 与 Electron E2E

2026-11-26 `npm run test:e2e`：**23 passed / 0 failed**，退出码 0。覆盖真实 Web、Electron BrowserWindow、旧版入口、主机档案、向导、演示、报告轮询/导出、首次安全确认、隐私徽标与失败重试。

## 性能基准

`node scripts/benchmark.mjs --engine --samples 7 --warmup 2`：全部阈值通过，`failures=[]`。

- cold P95 191.38ms；hot P95 188.57ms。
- cold hit rate 0；hot hit rate 1.0，hot writes 0。
- peak RSS 141.38MB；peak heap used 53.87MB。
- 冷/热吞吐分别 5.36 / 5.86 tasks/s。

## 跳过测试台账

| 用例 | 原因 | 覆盖方式 |
|---|---|---|
| API artifact symlink | Windows 跳过 | Linux CI |
| Android real JADX | 仅 `RE_RUN_ANDROID_REAL=1` | 官方 JADX workflow |
| Artifact read symlink | Windows 跳过 | Linux CI |
| External JADX home | POSIX fake Java | Linux CI / Windows 真实 JADX |
| JADX output symlink | Windows 跳过 | Linux CI |
| Linux sysfs permission | Windows 跳过 | Linux CI |
| Upload symlink | Windows 跳过 | Linux CI |
| Windows final symlink | 无符号链接权限时 EPERM | Junction 与 canonical alias 回归 |
| Project deletion parent symlink | Windows 跳过 | Linux CI；Windows Junction/reparse 既有覆盖 |

## 未验证与外部限制

- 未提供 PS5/Xbox/Android TV 真实设备；C4/C5 保持 BLOCKED。
- 未提供管理员权限、驱动安装、实时捕获、刷写授权。
- Windows 安装包未签名；macOS 未运行。
- 真实 AI 模型可选验收；无 Key 时确定性计划与规则分析完整可用。
