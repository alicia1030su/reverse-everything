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
| `npm test` | 50 files passed；525 passed / 7 skipped | 真实 Worker、浏览器、SQLite、Windows 文件安全、恶意输入与发行门禁回归 |
| `npm run test:e2e` | Windows 12/12；Ubuntu 11 passed / 1 skipped | 九入口、硬件实验室、首次引导、移动导航、主题、运维、项目复建任务与真实 Electron smoke |
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

## 最终 CI 真实验收（2026-11-25）

| 检查 | 结果 | Evidence |
|---|---|---|
| 主 CI：Windows / Ubuntu / Docker | 全部通过 | Run `45597842505`，Commit `f62539cf5bc30524be4cc153e42e68f5711a40b2` |
| Windows / Ubuntu 单元与集成 | 50 files passed；525 passed / 7 skipped | 同一主 CI Run |
| Windows / Ubuntu Web + Electron E2E | Windows 12/12；Ubuntu 11 passed / 1 skipped | 同一主 CI Run |
| JADX 1.5.3 官方 archive 与真实已知答案 | 通过 | Run `45597842518`；archive SHA256 `8280f3799c0273fe797a2bcd90258c943e451fd195f13d05400de5e6451d15ec` |
| Ghidra 12.2 / JDK25 官方 PE/ELF 已知答案 | Ubuntu PE/ELF 与 Windows PE 全部通过 | Run `45597842522`；archive SHA256 `2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67` |
| 确定性 APK fixture | 通过 | SHA256 `e95e6ba09e583baca616c83e9576517847d7f3a320c97b5ed6f8983ae63cd07b` |
| 固件 UTF-16LE 内存回归 | 通过 | 32MiB 输入、64MiB 堆子进程；修复前 OOM，修复后 maxRSS < 112MiB |
| 发行工作流身份门禁 | 通过 | 强制 main push 的 CI/JADX/Ghidra 三个命名工作流成功，拒绝 PR run、其他分支或缺失工作流 |

## 候选包、正式发行与公开复验

| 检查 | 结果 | Evidence |
|---|---|---|
| 冻结 Commit 主 CI | 全部通过 | Run `45608077356`，Commit `cfb19bbfa23d67ed23b660c793602bcadc1cffa6` |
| 冻结 Commit JADX 真实验收 | 全部通过 | Run `45608076801` |
| 冻结 Commit Ghidra 真实验收 | 全部通过 | Run `45608076834` |
| 候选构建与独立 acceptance | Linux/Windows/acceptance 通过 | Run `45611613592` |
| annotated Tag | 通过 | Tag object `bcf991f5b21e51ef83756e08ef98d32ccdcc276c` 解引用冻结 Commit |
| Draft 资产上传与逐项 digest | 12/12 通过 | 按 Draft Release ID 的 `upload_url` 上传，拒绝覆盖已有资产 |
| 正式发布与 Latest | 通过 | `draft=false`、`prerelease=false`，Latest=`v0.0.4` |
| 公开地址重新下载 | 12/12 通过 | `sha256sum -c SHA256SUMS.txt` 全部 OK |
| GitHub digest 对照 | 12/12 通过 | Release API digest 与 `SHA256SUMS.txt` 全量一致 |
| 发行恢复工作流 | 全绿 | Run `45622020772` |
| 发行脚本回归 | 6/6 通过 | Draft 列表回退、重复 tag 拒绝、Release ID 上传 URL |
| 发布后 main 本地门禁 | 50 files；528 passed / 8 skipped | `npm test`、`npm run typecheck`、`npm run lint`、`npm run docs:check` 全部通过 |

公开 Release：https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.4

## 未验证与外部限制

- 未获得物理 USB 设备、实时捕获、驱动安装、串口实时读取或刷写授权。
- Linux/Ubuntu 与 Docker 已在官方 CI 验证；macOS 与代码签名未验证。
- Windows 安装包未签名；不伪造代码签名。
