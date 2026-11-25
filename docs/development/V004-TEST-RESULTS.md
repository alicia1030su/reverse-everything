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

## 本地候选门禁（2026-11-25）

| 命令 / 检查 | 结果 | 备注 |
|---|---|---|
| `npm run build` | 通过 | contracts/evidence/security/ai/workflow/hardware/firmware/core/api/worker/cli/desktop/web 全量构建 |
| `npm run typecheck` | 通过 | `tsc -b` 与 Web 类型检查 |
| `npm run lint` | 通过 | 0 error / 0 warning |
| `npm test` | 49 files passed；513 passed / 7 skipped | 真实 Worker、浏览器、SQLite、Windows 文件安全与恶意输入回归 |
| `npx playwright test tests/e2e/web-v004.spec.ts` | 7/7 通过 | 九入口、硬件实验室、首次引导、移动导航、主题、运维、项目复建任务 |
| `npx playwright test --config=playwright.desktop.config.ts` | 1/1 通过 | 真实 Electron 指标 smoke、文件任务、报告/证据/产物下载、sidecar 孤儿检查 |
| `tests/integration/platform.test.ts` | 8/8 通过 | 独立 Worker、网页、游戏、安全、AI、SARIF、CLI/MCP |
| 硬件 5 个测试文件 | 42 passed / 1 skipped | H0/H1、枚举、capture、HID、官方样本 fixture；自由文本仅返回哈希 |
| `env -u NODE_TLS_REJECT_UNAUTHORIZED node scripts/validate-hardware-samples.mjs` | 3/3 官方样本通过 | SHA256 与解压哈希匹配；截断/unsupported link type 如实记录，不伪装完整解析 |
| 真实 Windows USB 只读枚举 | status=OK；8 devices；2 个含 VID/PID | 未打开句柄、未暴露序列号、未实时抓包 |
| `npm run check:secrets` | 通过 | 321 个文本文件 |
| `npm run licenses` | 通过 | 122 个生产包，无 disallowed license |
| `npm run sbom` | 通过 | 140 components |
| `npm run openapi` + contract test | 通过 | 47 paths，路由契约一致 |
| `npm run docs:check` / `validate:skill` / `version:check` | 通过 | 36 个本地链接；VERSION=0.0.4 同步 16 个文件 |
| Server / CLI / Skill 候选包 | 通过 | `reverse-everything-server-0.0.4.tar.gz`、CLI TGZ、Skill ZIP |
| Server TGZ 隔离验收 | 通过 | 临时目录解包、`npm ci --omit=dev`、API/Worker 启动、health 0.0.4、Web 首页 200、九个 adapter、neutral CWD Ghidra launcher 路径解析 |
| `npm audit --omit=dev --audit-level=high` | 通过 | 0 vulnerabilities |
| 独立只读复审 | P0=0 / P1=0 | workflow、APK/JADX、Ghidra、hardware/firmware、桌面、release 与文档声明 |
| Windows EXE / Portable | 通过 | EXE 与解包后 Portable 均以 `RE_SMOKE_TEST=1` 真实启动；health/capabilities/desktop metrics/neutral launcher 通过；未签名，不伪造代码签名 |

## 最终候选包 SHA256

| 文件 | SHA256 |
|---|---|
| `reverse-everything-server-0.0.4.tar.gz` | `c295d590d88fee7746f76a3094236a5e81fcab4e6d5d03e3e5243b181e98283a` |
| `reverse-everything-cli-0.0.4.tgz` | `77e945a1250699f2e43322547d8823340ec58c2a0c9dd18054681d9ce5c9bcc2` |
| `reverse-everything-skill-0.0.4.zip` | `d6530cf54023d685a186d77b0cd628947859fbdc58b43d347bf1927712be3c57` |
| `Reverse-Everything-Setup-0.0.4-win-x64.exe` | `5b372b6a1ce73bf18c9d2304233fff95db40bfe7c690a4f02041348dcbcca636` |
| `Reverse-Everything-Setup-0.0.4-win-x64.zip` | `ee9520d7158592bda71e006850b2b6ab71e71d149a69394fbcb7f64100a0500c` |

## 未验证与外部限制

- Ghidra 12.2/JDK25 与 JADX 1.5.3 的官方已知答案 CI 尚未在本工作区完成；能力保持 `PARTIAL` / `BLOCKED`，fake 工具测试不等于真实验收。
- 未获得物理 USB 设备、实时捕获、驱动安装、串口实时读取或刷写授权。
- Docker/Linux/macOS 与代码签名未在本机执行；不得标为通过。
- v0.0.4 Tag、Draft/正式 Release、CI Run ID 与公开资产 digest 尚未创建。
