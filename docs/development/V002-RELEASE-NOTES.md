# 逆向万物 v0.0.2

v0.0.2 将 v0.0.1 的单机分析工作台扩展为统一核心的六入口平台，并补齐长期运行所需的迁移、缓存、资源与发行能力。

## 新增

- SQLite Schema 2：迁移前自动备份、事务迁移、v0.0.1 数据保留、重复迁移安全。
- 分类保留策略、dry-run 清理、审计记录；不自动删除原始上传和正式报告。
- 项目隔离的内容寻址跨任务缓存、原子写入、LRU、损坏回退和统计。
- API/Worker 进程树资源指标、CPU/磁盘/句柄、任务预算、三级熔断与检查点。
- `/api/v1` 兼容别名、稳定错误码、限速、证据/缓存/保留/资源端点、OpenAPI。
- 完整 CLI、可全局安装 npm TGZ、Node 22 服务端 TGZ。
- 官方 MCP SDK：stdio + Streamable HTTP，17 个工具，真实客户端协议测试。
- 标准 Agent Skill 包、环境检查与任务查看脚本。
- Electron Windows 桌面壳、NSIS 安装包、便携 ZIP、Sidecar 生命周期与 CI smoke。
- Web 系统状态、资源、缓存、保留、开发者接入和诊断页面。
- Windows/Ubuntu/Docker 质量门禁与多资产 Release 工作流。

## 验证

- 30 项单元/集成测试、2 项浏览器 E2E。
- 官方 MCP stdio/HTTP 客户端握手和工具调用。
- v0.0.1 真实结构升级、缓存损坏/隔离/淘汰、超时/熔断、保留 dry-run。
- CLI TGZ 干净安装、服务端 TGZ Linux 安装启动、Skill ZIP 解压校验。
- Windows 安装版与便携版 CI 启动 smoke；Docker Compose 健康检查。

## 限制

- 未签名 Windows 安装包可能触发 SmartScreen。
- Tauri 路线因本机无 Rust 未构建原型；桌面选择 Electron 并必须通过 CI smoke。
- 浏览器分析需 Chromium；基础离线分析不依赖浏览器。
- 游戏兼容服务仍是独立回放实现，不是原始服务端恢复。
- 高级原生反编译、APK/DEX、HAR/PCAP、多页面克隆仍属于后续版本。
