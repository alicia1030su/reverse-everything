# 逆向万物 v0.0.4 最终交付报告

状态：**v0.0.4 已正式发布**。公开 Release、Latest 状态、12 个资产的 GitHub digest 与 `SHA256SUMS.txt` 均已复核通过。

## 发行结果

| 项目 | 结果 |
|---|---|
| Release | https://github.com/alicia1030su/reverse-everything/releases/tag/v0.0.4 |
| Tag | `v0.0.4`（annotated） |
| Tag object | `bcf991f5b21e51ef83756e08ef98d32ccdcc276c` |
| Tag 解引用 Commit | `cfb19bbfa23d67ed23b660c793602bcadc1cffa6` |
| 候选构建 Run | `45611613592`；Linux/Windows/独立 acceptance 均通过 |
| 发行恢复 Run | `45622020772`；上传、Draft 校验、发布、公开地址复验全部通过 |
| 发布时间 | `2026-11-25T13:16:14Z` |
| 资产 | 12 个；名称、大小、GitHub digest 与 `SHA256SUMS.txt` 全量一致 |
| Latest | `draft=false`、`prerelease=false`，GitHub Latest 指向 `v0.0.4` |

## 当前交付范围

- 中英文 README 与 PRD/架构/安全模型/路线图更新到 v0.0.4。
- 九类入口：website/software/android/game/network/security/usb/firmware/board；usb 与 board 的 kind/adapter 均为 `hardware`，board 不调用 `firmware`。
- CLI 实际命令、REST/OpenAPI v0.0.4、MCP 21 工具与 Skill 工作流。
- 硬件只读枚举、离线 USB/HID/串口列表与固件静态分析安全边界。
- 缓存、保留、删除、桌面指标、Windows ACL 与单实例语义。
- Ghidra 12.2/JDK25 与 JADX 1.5.3 官方 archive、真实工具和已知答案 CI。

## 最终门禁

| 项目 | 结果 |
|---|---|
| 冻结 Commit 主 CI | Run `45608077356` 全绿 |
| 冻结 Commit JADX 真实验收 | Run `45608076801` 全绿 |
| 冻结 Commit Ghidra 真实验收 | Run `45608076834` 全绿 |
| 单元/集成 | 冻结 Commit：50 files；525 passed / 7 skipped；发布后 main 本地：50 files；528 passed / 8 skipped |
| Web/Electron E2E | 冻结候选：Windows 12/12，Ubuntu 11 passed / 1 skipped |
| 候选 Linux | 质量门禁、CLI/Server/Skill 隔离 smoke、Docker health 通过 |
| 候选 Windows | 静默安装、Portable、neutral CWD Ghidra launcher smoke 通过 |
| 独立 acceptance | `ACCEPTANCE.json`、`BUILD-INFO.json`、`RELEASE-MANIFEST.json`、`SHA256SUMS.txt` 通过 |
| 公开资产复验 | 从公开 Release 重新下载 12 个资产，`sha256sum -c SHA256SUMS.txt` 全部 OK |
| 发行脚本回归 | Draft 列表回退、重复 tag 拒绝、按 Release ID 上传等 6/6 通过 |

## 独立复审与已知 P2

- 冻结前独立只读复审：P0=0 / P1=0；覆盖 workflow、APK/JADX、Ghidra、hardware/firmware、桌面指标、release 与文档声明。
- 固件 UTF-16LE 扫描 OOM P1 已修复，并以 32MiB 输入、64MiB 堆子进程回归关闭。
- 非阻断 P2：macOS `ps` 时间分量严格校验；APK `prepare` 成功后任务中止的快照由临时目录保留策略兜底；缓存 payload 非原子替换；浏览器依赖版本漂移检查。

## 发行恢复说明

原始原子发行 Run `45611613592` 的候选构建、独立验收、annotated Tag 和 Draft 创建均成功，但资产上传阶段暴露两个 Draft 定位问题：

1. GitHub 的 `releases/tags/{tag}` 端点不返回 Draft，已通过列表端点回退修复。
2. `gh release upload <tag>` 在 Draft 场景下无法按 Tag 定位 Release，可能新建 Draft 并将原 Draft 改为 `untagged-*`；已改为直接使用 Draft 的 `upload_url`，按 Release ID 上传，并增加回归测试。

恢复过程中删除了全部空 Draft，使用修复后的脚本完成上传与发布。最终恢复 Run `45622020772` 全绿，公开资产复验通过；未覆盖历史 Tag/Release，未伪造签名或物理设备验收。

## 未验证声明

- 未获得物理设备、实时捕获、驱动安装或刷写授权。
- Ghidra/JADX 仅在官方 CI 的 PE/ELF/APK 已知答案范围内视为已验证；不宣称所有格式、所有架构或物理设备兼容。
- 未运行的 macOS、代码签名、物理设备或性能检查不标为通过。
- 不宣称完整网站克隆、原始游戏服务端恢复或自动漏洞利用。
