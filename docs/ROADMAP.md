# 逆向万物路线图

所有版本状态以代码、测试、CI 与发布记录为准。v0.0.4 当前位于开发分支，不表示正式 Tag 或 Release 已发布。

## v0.0.1：可验证基础平台

- Monorepo、Web/API/Worker/CLI/MCP。
- 项目、上传、哈希、SQLite 任务、检查点、SSE。
- 网页采集、文件静态分析、基础安全、可选 AI。
- 自编写游戏协议推断、独立兼容服务与 E2E。
- Docker Compose、CI、文档与真实示例。

## v0.0.2：分析效率

- Schema 迁移、备份/隔离恢复。
- 跨任务缓存、保留策略、资源指标与内存压力。
- CLI TGZ、Server TGZ、Skill、Windows 安装/便携版。

## v0.0.3：网页与深度逆向

- 多页面网页采集、HAR/PCAP/PCAPNG 离线解析。
- APK/ZIP/AXML/DEX 静态元数据。
- Ghidra Headless 基础进程链。
- 可证明发行流程与全入口契约。

## v0.0.4：硬件实验室与原生分析（开发中）

### 已实现代码

- 九类入口：website/software/android/game/network/security/usb/firmware/board；usb 与 board 的 kind/adapter 均为 `hardware`，board 不调用 `firmware`，不新增 adapter。
- Windows/Linux USB 与串口只读枚举、设备身份/拓扑与脱敏。
- 离线 USB PCAP/PCAPNG/usbmon、HID 描述符与快照解析。
- 固件 BIN/IMG、Intel HEX、UF2、ELF、ZIP 清单、熵、字符串、布局、组件/SBOM 线索。
- Ghidra 伪代码/调用图/字符串引用与 JADX 反编译进程链。
- CLI 硬件/固件命令、MCP 21 工具、OpenAPI v0.0.4、Skill 工作流。
- 桌面真实进程指标、Windows 私有快照 ACL、API/Electron 单实例。
- 缓存/保留/删除语义与安全边界文档。

### 部分完成或阻塞

- Ghidra/JADX：官方已知答案 CI 与工具 provenance 已通过；最终发行包路径由候选工作流复验，未测试格式/架构不宣称支持。
- 硬件：官方离线样本与本机只读枚举需最终门禁；物理设备、实时捕获、驱动与刷写未授权。
- 网页兼容产物仍为静态预览，不是完整动态网站克隆。
- AI Planner/Validator 与 bounded repair 保持受限，不宣称自动代码修复。
- 最终测试数量、性能、CI Run ID、安装包与 Release 状态以最终门禁为准。

## v0.0.5：移动应用深化

- Android 资源与更多组件语义、AAB；真实 JADX 已知答案进入常规门禁。
- iOS 仅静态资源与可合法分析结构，深度能力另行验证。

## v0.0.6：协议理解

- WebSocket/JSON/XML/Protobuf/二进制样本、字段关联、请求响应匹配、状态机与本地回放。
- 仅在授权离线数据上推进。

## v0.0.7：游戏复活

- Unity/Unreal/Godot/Cocos 识别、资源包、存档、协议恢复、离线流程。
- L0–L5 逐级证据，不承诺每款游戏达到 L5。

## v0.0.8：安全研究

- 经验证的 SBOM 漏洞匹配、更多 CWE/OWASP 规则、SARIF 质量、授权范围与复测。

## v0.0.9：多 Agent 协同

- Planner/Inspector/Protocol/Reconstruction/Security/Validation/Reviewer 共享结构化状态；多模型路由与预算。

## v0.1.0：完整工作流

- 网页、软件、游戏、硬件与固件的跨层证据和行为对比。
- 可复现构建、失败项目标注与更成熟的数字保存治理。

## v0.2.0 → v1.0.0

- 分布式 Worker、插件生态、更多平台、成熟发布与合规治理。

## 明确不做

- 无授权扫描、绕过访问控制、自动窃取数据、漏洞批量利用。
- 打开未授权设备、实时键盘捕获、未授权固件刷写。
- 自动分发无授权商业资源。
- 把模型猜测当作事实。
- 用占位按钮、随机进度、预写兼容服务冒充自动恢复。
