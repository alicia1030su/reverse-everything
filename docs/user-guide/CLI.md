# CLI 指南（v0.0.5）

## 启动与认证

先运行 `npm run build`。仓库内使用：

```bash
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
```

安装 CLI 包后使用 `reverse-everything`。CLI 默认连接 `http://127.0.0.1:4173`，从 `RE_DATA_DIR/local-token`（默认 `data/local-token`）读取令牌，也可设置：

```bash
export RE_API_URL=http://127.0.0.1:4173
export RE_API_TOKEN=<local-token>
export RE_DATA_DIR=/absolute/data
```

不要把令牌放入 URL 或提交到仓库。全局参数为 `--json`、`--quiet`、`--timeout <ms>`、`--api-url <url>`；`--timeout` 同时用于 HTTP 超时和任务等待预算。Ctrl+C 只终止当前等待，不删除服务端任务。

## 九类入口与实际路由

| 用户入口 | `projects create` 的 kind | `tasks create` 的 adapter |
|---|---|---|
| website | `website` | `website` |
| software | `software` | `file` |
| android | `software` | `apk` |
| game | `game` | `game` |
| network | `protocol` | `network` |
| security | `security` | `security` |
| usb | `hardware` | `hardware` |
| firmware | `firmware` | `firmware` |
| board | `hardware` | `hardware` |
| console | `console` | `console` |

第七类入口 id 为 `usb`，CLI/API 对应 `hardware`。`board` 是开发板场景路由，仅复用 `hardware`，不调用 `firmware`，不是新 adapter，也不宣称特定品牌/型号或实时设备支持。Ghidra 使用 `software` 项目与 `ghidra` adapter；官方 Ghidra/JDK 已知答案 CI 已通过，验证范围限于 CI 覆盖的 PE/ELF 样本。

## 健康、能力与资源

```bash
reverse-everything health
reverse-everything capabilities
reverse-everything analyzers list
reverse-everything config show
reverse-everything resources status
reverse-everything cache stats
reverse-everything retention show
```

`capabilities` 与 `analyzers list` 都读取 `/api/capabilities`。`resources status` 返回真实 API/Worker/Desktop 快照；采样限制记录在 `limitations`。

## 创建项目、上传与分析

```bash
reverse-everything projects list
reverse-everything projects create "授权软件样本" software --authorized
reverse-everything projects upload <projectId> ./sample.bin
reverse-everything tasks create <projectId> file
reverse-everything analyze file ./sample.bin --authorized
reverse-everything analyze web https://example.com --authorized
reverse-everything analyze web http://127.0.0.1:3100 --authorized --confirm-local
reverse-everything firmware inspect ./firmware.bin --authorized
```

`analyze file` 与 `firmware inspect` 会自动创建项目、上传并创建任务；加 `--no-wait` 可立即返回任务 ID。`analyze web` 只接受 HTTP/HTTPS，本地目标还需 `--confirm-local`。

项目 kind 的有效值为 `website`、`software`、`game`、`security`、`protocol`、`hardware`、`firmware`、`console`。任务 adapter 的有效值为 `website`、`file`、`security`、`game`、`network`、`apk`、`ghidra`、`hardware`、`firmware`、`console`。

## 任务与报告

```bash
reverse-everything tasks list
reverse-everything tasks get <taskId>
reverse-everything tasks logs <taskId>
reverse-everything tasks action <taskId> pause
reverse-everything tasks action <taskId> resume
reverse-everything tasks action <taskId> cancel
reverse-everything tasks action <taskId> retry
reverse-everything report export <taskId> ./report.md
```

动作在安全阶段边界生效；非法状态转换返回 409。`report export` 在报告就绪后下载 Markdown。当前 CLI 没有 `tasks report` 或 `tasks artifact` 子命令。

## 硬件与开发板

```bash
reverse-everything hardware list
reverse-everything hardware doctor
reverse-everything hardware serial
```

当前 CLI 硬件子命令为 `hardware list|doctor|serial`；硬件能力也可由 `capabilities` 或 REST `GET /api/hardware/capabilities` 获取。

这些命令仅从本机回环 API 读取 OS 可见信息：

- 不打开 USB 设备句柄或串口，不改变 DTR/RTS。
- 不启动实时捕获，不采集键盘报告，不安装驱动。
- 远程 API 模式会拒绝硬件枚举。
- 开发板分析使用用户提供的离线固件/记录；查看串口不等于获得登录、复位或刷写授权。

离线上传示例：

```bash
reverse-everything projects create "授权 USB 记录" hardware --authorized
reverse-everything projects upload <projectId> ./usb-capture.pcapng
reverse-everything tasks create <projectId> hardware
```

## 主机研究、计划与演示

```bash
reverse-everything console devices
reverse-everything console device ps5
reverse-everything plans create <projectId> "总结离线请求" ./capture.har --authorized
reverse-everything plans list <projectId>
reverse-everything plans get <planId>
reverse-everything plans execute <planId>
reverse-everything tools list
reverse-everything demos list
reverse-everything demos run firmware
reverse-everything report plain <taskId> ./plain-report.md
```

`plans create` 会创建显式授权范围、读取文件头部并生成确定性计划；不会自动安装工具或扩大权限。`demos run` 创建真实项目与任务，不伪造成功结果。

## MCP

```bash
reverse-everything mcp stdio
reverse-everything mcp http --port 4174
```

stdio 的本地文件读取必须配置 `RE_MCP_ALLOWED_ROOTS`；HTTP MCP 只接受 `contentBase64`，不读取任意本机路径。默认 HTTP 地址为 `http://127.0.0.1:4174/mcp`，使用同一 Bearer Token。

## 退出码与失败

- `0`：命令成功。
- `2`：缺少/无效本地令牌或认证失败。
- `3`：任务状态冲突。
- `4`：超时或队列/速率限制。
- `1`：参数、网络、适配器不可用或其他错误。

任务等待超时不会取消任务；使用返回的任务 ID 继续查询。能力不可用时不要创建假任务，先检查 `health`、`capabilities` 与工具可用性。
