# 逆向万物 v0.0.4 最终交付报告

状态：**本地候选门禁通过；CI 真实工具验收与正式发行未完成**。本报告不表示 v0.0.4 Tag 或 Release 已创建。

## 当前交付范围

- 中英文 README 与 PRD/架构/安全模型/路线图更新到 v0.0.4。
- 九类入口文档：website/software/android/game/network/security/usb/firmware/board；usb 与 board 的 kind/adapter 均为 `hardware`，board 不调用 `firmware`，不虚构 adapter。
- CLI 实际命令、REST/OpenAPI v0.0.4、MCP 21 工具与 Skill 工作流。
- 硬件只读枚举、离线 USB/HID/串口列表与固件静态分析安全边界。
- 缓存、保留、删除、桌面指标、Windows ACL 与单实例语义。
- Ghidra/JADX 标为 `PARTIAL` / `BLOCKED`，真实 CI 证据完成前不得标 `VERIFIED`。

## 必须由最终门禁填写

| 项目 | 当前状态 |
|---|---|
| 代码/测试/文档哈希 | 本地候选已冻结；Commit 待创建 |
| 单元/集成/E2E/Windows/Linux/Docker 结果 | 本地 49 files / 513 passed / 7 skipped；Web 7/7、Electron 1/1；独立复审 P0=0/P1=0；Linux/Docker 未在本机执行 |
| Ghidra/JADX 真实工具 CI | 待完成，保持 PARTIAL/BLOCKED |
| 官方离线样本与物理设备边界 | 3/3 官方样本哈希与解析通过；Windows 只读枚举 8 devices；物理设备未授权 |
| CLI/Server/Skill/OpenAPI/EXE/Portable 安装验收 | CLI/Server/Skill/OpenAPI 本地通过；Server 隔离安装启动通过；EXE 与解包后 Portable 真实 smoke 通过 |
| 性能、缓存冷热与桌面指标 | 桌面真实 smoke 通过；缓存热路径 3 writes / 33 hits；跨平台性能未承诺 |
| 候选构建 Commit 与资产 digest | 待冻结 |
| Tag、Release URL、Run ID、发布时间 | 尚未创建/未定稿 |

## 独立复审与已知 P2

- 最终只读独立复审：P0=0 / P1=0；审查覆盖 workflow、APK/JADX、Ghidra、hardware/firmware、桌面指标、release 与文档声明。
- 非阻断 P2：macOS `ps` 时间分量严格校验；APK `prepare` 成功后任务中止的快照由临时目录保留策略兜底；缓存 payload 非原子替换；浏览器依赖版本漂移检查。桌面 resource_samples 保留策略、PCAP 魔数歧义、设备自由文本哈希与 UF2 O(n²) 已在最终代码修复并纳入回归。
- 上述 P2 不改变 P0/P1 清零结论；真实工具 CI 与物理设备限制仍按下方声明处理。

## 未验证声明

- 未获得物理设备、实时捕获、驱动安装或刷写授权。
- 未获得真实 Ghidra/JDK/JADX 完整 CI 证据前，不宣称相关能力 `VERIFIED`。
- 未运行的容器、Windows、浏览器、安装包或性能检查不标为通过。
- 不宣称完整网站克隆、原始游戏服务端恢复或自动漏洞利用。

最终报告必须来自实际代码、测试输出、CI 和公开发行地址；所有未定稿数据以最终门禁为准。
